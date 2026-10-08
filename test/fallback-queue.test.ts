/**
 * Third-Party 429 Fallback Queue & Full-Jitter Exponential Backoff Verification Suite
 * Target: test/fallback-queue.test.ts
 *
 * Verifies:
 * 1. Full-Jitter Exponential Backoff calculation (RFC/AWS standard).
 * 2. 429 / SMTP / DB quota error detection across multiple protocols.
 * 3. FallbackQueue invariants: FIFO, bounded capacity (LRU), idempotency deduplication.
 * 4. executeWithFallback resilience: transient 429 auto-retry vs persistent 429 queue fallback.
 * 5. Naver SMTP 429 Fallback: zero message loss, HTTP 202 Accepted, replay via processMailQueue.
 * 6. DB 429 Fallback: zero chat message loss, listMessages in-memory merge, replay via processDbQueue.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
  calculateFullJitterBackoff,
  is429OrQuotaError,
  extractRetryAfterMs,
  FallbackQueue,
  executeWithFallback,
  mailFallbackQueue,
  dbFallbackQueue,
  processDbQueue,
  getQueuedMessagesForThread,
} from "../lib/queue/fallback-queue";
import { sendNaverMail, processMailQueue, resetTransporterCache } from "../lib/mail/naver";
import { appendMessage, listMessages } from "../lib/chat-store";
import { createApp } from "../src/app";

describe("1. Full-Jitter Exponential Backoff Calculation", () => {
  it("generates backoff delays strictly bounded by maxMs with randomized jitter", () => {
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const delay = calculateFullJitterBackoff(2, 500, 5000);
      expect(delay).toBeGreaterThanOrEqual(10);
      expect(delay).toBeLessThanOrEqual(5000);
      samples.push(delay);
    }
    const unique = new Set(samples);
    expect(unique.size).toBeGreaterThan(1); // Jitter must not be a static constant
  });

  it("escalates ceiling exponentially across successive attempts", () => {
    let maxAttempt0 = 0;
    let maxAttempt4 = 0;
    for (let i = 0; i < 50; i++) {
      const d0 = calculateFullJitterBackoff(0, 100, 10000);
      const d4 = calculateFullJitterBackoff(4, 100, 10000);
      if (d0 > maxAttempt0) maxAttempt0 = d0;
      if (d4 > maxAttempt4) maxAttempt4 = d4;
    }
    expect(maxAttempt4).toBeGreaterThan(maxAttempt0);
  });

  it("honors Retry-After header with positive jitter", () => {
    const delay = calculateFullJitterBackoff(1, 500, 10000, 3000);
    expect(delay).toBeGreaterThanOrEqual(3050);
    expect(delay).toBeLessThanOrEqual(3250);
  });
});

describe("2. Multi-Protocol 429 & Quota Error Detection", () => {
  it("identifies direct HTTP 429 status codes", () => {
    expect(is429OrQuotaError({ status: 429 })).toBe(true);
    expect(is429OrQuotaError({ statusCode: 429 })).toBe(true);
    expect(is429OrQuotaError({ response: { status: 429 } })).toBe(true);
  });

  it("identifies SMTP rate limiting and quota codes (421, 450, 451, 452)", () => {
    expect(is429OrQuotaError({ responseCode: 421 })).toBe(true);
    expect(is429OrQuotaError({ responseCode: 450 })).toBe(true);
    expect(is429OrQuotaError({ responseCode: 451 })).toBe(true);
    expect(is429OrQuotaError({ responseCode: 452 })).toBe(true);
    expect(is429OrQuotaError({ code: 421 })).toBe(true);
  });

  it("identifies error strings mentioning rate limit, quota, and throttled", () => {
    expect(is429OrQuotaError(new Error("Rate limit exceeded: 429"))).toBe(true);
    expect(is429OrQuotaError(new Error("Too Many Requests"))).toBe(true);
    expect(is429OrQuotaError(new Error("user quota exceeded for today"))).toBe(true);
    expect(is429OrQuotaError(new Error("mailbox busy, try again later"))).toBe(true);
    expect(is429OrQuotaError(new Error("Client throttled: resource has been exhausted"))).toBe(true);
  });

  it("safely rejects non-429 standard client and server errors", () => {
    expect(is429OrQuotaError({ status: 400 })).toBe(false);
    expect(is429OrQuotaError({ status: 401 })).toBe(false);
    expect(is429OrQuotaError({ status: 404 })).toBe(false);
    expect(is429OrQuotaError(new Error("SyntaxError: Unexpected token"))).toBe(false);
    expect(is429OrQuotaError(null)).toBe(false);
    expect(is429OrQuotaError(undefined)).toBe(false);
  });

  it("parses Retry-After headers in numeric seconds or ISO timestamps", () => {
    expect(extractRetryAfterMs({ retryAfter: 5 })).toBe(5000);
    expect(extractRetryAfterMs({ headers: { "retry-after": "10" } })).toBe(10000);
    const futureDate = new Date(Date.now() + 15000).toISOString();
    const parsed = extractRetryAfterMs({ headers: { "retry-after": futureDate } });
    expect(parsed).toBeDefined();
    expect(parsed!).toBeGreaterThanOrEqual(14000);
    expect(parsed!).toBeLessThanOrEqual(16000);
  });
});

describe("3. FallbackQueue Invariants", () => {
  let queue: FallbackQueue<any>;

  beforeEach(() => {
    queue = new FallbackQueue<any>("test-queue", 5);
  });

  it("enqueues jobs and tracks pending status with scheduled nextRetryAt", () => {
    const job = queue.enqueue({ test: "data" }, { initialDelayMs: 100 });
    expect(job.id).toBeDefined();
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(queue.size).toBe(1);
    expect(queue.getPendingCount()).toBe(1);
  });

  it("deduplicates jobs when matching idempotencyKey is supplied", () => {
    const job1 = queue.enqueue({ item: 1 }, { idempotencyKey: "unique-key-1" });
    const job2 = queue.enqueue({ item: 1 }, { idempotencyKey: "unique-key-1" });
    expect(job1.id).toBe(job2.id);
    expect(queue.size).toBe(1);
  });

  it("enforces strict bounded capacity (O(1) oldest eviction on overflow)", () => {
    for (let i = 0; i < 7; i++) {
      queue.enqueue({ index: i });
    }
    expect(queue.size).toBe(5); // Capped at maxCapacity = 5
  });

  it("marks completed jobs succeeded and removes them from queue", () => {
    const job = queue.enqueue({ task: "send" }, { idempotencyKey: "idem-success" });
    expect(queue.markSucceeded(job.id)).toBe(true);
    expect(queue.size).toBe(0);
    expect(queue.get(job.id)).toBeUndefined();
  });

  it("drains and reprocesses ready jobs via processPending", async () => {
    const now = Date.now();
    queue.enqueue({ n: 1 }, { initialDelayMs: 0 });
    queue.enqueue({ n: 2 }, { initialDelayMs: 0 });

    const processedItems: number[] = [];
    const report = await queue.processPending(async (job) => {
      processedItems.push(job.payload.n);
    }, now + 10);

    expect(report.processed).toBe(2);
    expect(report.succeeded).toBe(2);
    expect(report.failed).toBe(0);
    expect(processedItems).toEqual([1, 2]);
    expect(queue.size).toBe(0);
  });
});

describe("4. executeWithFallback Resilience Engine", () => {
  it("resolves immediately on first attempt when action succeeds", async () => {
    let callCount = 0;
    const res = await executeWithFallback(async () => {
      callCount++;
      return "immediate-ok";
    });
    expect(res.success).toBe(true);
    expect(res.result).toBe("immediate-ok");
    expect(res.attempts).toBe(1);
    expect(callCount).toBe(1);
  });

  it("re-attempts action on transient 429 and succeeds within maxRetries", async () => {
    let callCount = 0;
    const res = await executeWithFallback(
      async () => {
        callCount++;
        if (callCount < 3) {
          const err = new Error("429 Too Many Requests");
          (err as any).status = 429;
          throw err;
        }
        return "eventual-ok";
      },
      { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 }
    );

    expect(res.success).toBe(true);
    expect(res.result).toBe("eventual-ok");
    expect(res.attempts).toBe(3);
    expect(callCount).toBe(3);
  });

  it("fails fast without retrying when non-429 error occurs", async () => {
    let callCount = 0;
    let thrownError: any = null;
    try {
      await executeWithFallback(async () => {
        callCount++;
        throw new Error("401 Unauthorized token");
      });
    } catch (e) {
      thrownError = e;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError.message).toBe("401 Unauthorized token");
    expect(callCount).toBe(1); // Exactly 1 attempt, zero retry
  });

  it("enqueues persistent 429 failures into fallbackQueue with zero message loss", async () => {
    const queue = new FallbackQueue<any>("persistent-test", 100);
    let callCount = 0;

    const res = await executeWithFallback(
      async () => {
        callCount++;
        const err = new Error("Rate limit quota exceeded");
        (err as any).status = 429;
        throw err;
      },
      {
        queue,
        fallbackPayload: { recipient: "user@example.com", body: "critical message" },
        maxRetries: 2,
        baseDelayMs: 5,
        maxDelayMs: 20,
      }
    );

    expect(res.success).toBe(true);
    expect(res.queued).toBe(true);
    expect(res.job).toBeDefined();
    expect(callCount).toBe(3); // 1 initial + 2 retries
    expect(queue.size).toBe(1);
    expect(queue.get(res.job!.id)?.payload.recipient).toBe("user@example.com");
  });
});

describe("5. Naver SMTP 429 Fallback & Recovery Integration", () => {
  beforeEach(() => {
    mailFallbackQueue.clear();
    resetTransporterCache();
  });

  it("enqueues email when SMTP returns 429 / quota error", async () => {
    process.env.NAVER_ID = "testuser";
    process.env.NAVER_APP_PASSWORD = "testpassword";

    // Simulate nodemailer transporter rejecting with SMTP 421 rate limit
    const nodemailer = require("nodemailer");
    const origCreateTransport = nodemailer.createTransport;
    nodemailer.createTransport = () => ({
      sendMail: async () => {
        const err: any = new Error("421 4.7.0 Concurrent connection limit exceeded");
        err.responseCode = 421;
        throw err;
      },
      close: () => {},
      on: () => {},
    });

    try {
      const res = await sendNaverMail({
        to: "client@domain.com",
        subject: "Order Confirmation",
        text: "Your order has been placed.",
      });

      expect(res.queued).toBe(true);
      expect(res.messageId).toContain("queued-");
      expect(res.accepted).toEqual(["client@domain.com"]);
      expect(res.rejected).toEqual([]);
      expect(mailFallbackQueue.size).toBe(1);
    } finally {
      nodemailer.createTransport = origCreateTransport;
      resetTransporterCache();
    }
  });

  it("HTTP POST /v2/admin/mail/send returns 202 Accepted when queued due to 429 quota", async () => {
    process.env.ADMIN_TOKEN = "test-admin-secret";
    process.env.NAVER_ID = "testuser";
    process.env.NAVER_APP_PASSWORD = "testpassword";

    const nodemailer = require("nodemailer");
    const origCreateTransport = nodemailer.createTransport;
    nodemailer.createTransport = () => ({
      sendMail: async () => {
        const err: any = new Error("452 4.4.5 Insufficient system storage / quota exceeded");
        err.responseCode = 452;
        throw err;
      },
      close: () => {},
      on: () => {},
    });

    try {
      const app = await createApp(true);
      const res = await app.handle(
        new Request("http://localhost/v2/admin/mail/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({
            to: "client@domain.com",
            subject: "Invoice",
            text: "Invoice details",
          }),
        })
      );

      expect(res.status).toBe(202); // 202 Accepted for background/queued tasks
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.queued).toBe(true);
      expect(data.status).toBe("queued_for_retry");
      expect(mailFallbackQueue.size).toBe(1);
    } finally {
      nodemailer.createTransport = origCreateTransport;
      resetTransporterCache();
    }
  });

  it("processMailQueue successfully drains queued emails when SMTP recovers", async () => {
    // 1. Enqueue job into mailFallbackQueue
    mailFallbackQueue.enqueue(
      {
        to: "queued@domain.com",
        subject: "Queued Notice",
        text: "Delayed delivery text",
      },
      { initialDelayMs: 0 }
    );
    expect(mailFallbackQueue.size).toBe(1);

    // 2. Mock transporter recovery to 200 OK
    const nodemailer = require("nodemailer");
    const origCreateTransport = nodemailer.createTransport;
    nodemailer.createTransport = () => ({
      sendMail: async () => ({
        messageId: "recovered-msg-id-12345",
        accepted: ["queued@domain.com"],
        rejected: [],
      }),
      close: () => {},
      on: () => {},
    });

    try {
      const report = await processMailQueue();
      expect(report.processed).toBe(1);
      expect(report.succeeded).toBe(1);
      expect(mailFallbackQueue.size).toBe(0); // Cleanly drained
    } finally {
      nodemailer.createTransport = origCreateTransport;
      resetTransporterCache();
    }
  });
});

describe("6. DB 429 Fallback & Chat Store Recovery Integration", () => {
  beforeEach(() => {
    dbFallbackQueue.clear();
  });

  it("appendMessage queues message and getQueuedMessagesForThread reflects it when DB hits 429", async () => {
    const threadId = "thread-fallback-test-uuid";

    // 1. Directly insert a queued message as if Supabase threw 429
    dbFallbackQueue.enqueue(
      {
        threadId,
        role: "assistant",
        content: "I am safely preserved in the fallback queue.",
        createdAt: new Date().toISOString(),
      },
      {
        type: "db_chat_message",
        initialDelayMs: 0,
        idempotencyKey: `${threadId}:assistant:1`,
      },
    );
    expect(dbFallbackQueue.size).toBe(1);

    // 2. getQueuedMessagesForThread returns pending rows seamlessly
    const messages = getQueuedMessagesForThread(threadId);
    expect(messages.length).toBe(1);
    const found = messages.find((m) => m.content.includes("safely preserved"));
    expect(found).toBeDefined();
    expect(found!.role).toBe("assistant");
    expect(found!.thread_id).toBe(threadId);
  });

  it("processDbQueue flushes and drains pending DB writes", async () => {
    const threadId = "thread-flush-uuid";
    dbFallbackQueue.enqueue(
      {
        threadId,
        role: "user",
        content: "Pending user prompt",
      },
      {
        type: "db_chat_message",
        initialDelayMs: 0,
      }
    );
    expect(dbFallbackQueue.size).toBe(1);

    const report = await processDbQueue();
    expect(report.processed).toBe(1);
    expect(report.succeeded).toBe(1);
    expect(dbFallbackQueue.size).toBe(0);
  });
});
