import { describe, expect, it } from "bun:test";
import {
  FallbackQueue,
  extractRetryAfterMs,
  calculateFullJitterBackoff,
  getQueuedMessagesForThread,
  dbFallbackQueue,
  is429OrQuotaError,
} from "../lib/queue/fallback-queue";
import {
  extractClientIp,
  resolvePolicy,
  normalizeIp,
  checkRateLimit,
  setTestRateLimitEnforced,
  resetRateLimitsForTesting,
} from "../lib/rate-limit";
import { createApp } from "../src/app";

describe("Adversarial Reviewer Verification Suite", () => {
  it("VULN-1: processPending concurrent double-execution race condition", async () => {
    const queue = new FallbackQueue<number>("test-race", 10);
    queue.enqueue(1, { initialDelayMs: 0 });
    queue.enqueue(2, { initialDelayMs: 0 });

    const executionLog: Array<{ caller: string; item: number }> = [];

    // Simulate two concurrent consumers draining the queue
    const p1 = queue.processPending(async (job) => {
      executionLog.push({ caller: "worker-1", item: job.payload });
      await new Promise((r) => setTimeout(r, 20)); // simulated async I/O
    });

    const p2 = queue.processPending(async (job) => {
      executionLog.push({ caller: "worker-2", item: job.payload });
      await new Promise((r) => setTimeout(r, 20)); // simulated async I/O
    });

    await Promise.all([p1, p2]);

    // Item 1 and Item 2 must NEVER be processed twice!
    const item1Count = executionLog.filter((e) => e.item === 1).length;
    const item2Count = executionLog.filter((e) => e.item === 2).length;

    expect(item1Count).toBe(1);
    expect(item2Count).toBe(1);
  });

  it("VULN-2: getQueuedMessagesForThread drops messages during active processing", async () => {
    dbFallbackQueue.clear();
    const threadId = "thread-vanish-test";

    const job = dbFallbackQueue.enqueue(
      {
        threadId,
        role: "user",
        content: "Temporary vanish message",
      },
      { type: "db_chat_message", initialDelayMs: 0 }
    );

    // When the job is marked processing (e.g. while processDbQueue is sending to DB)
    dbFallbackQueue.markProcessing(job.id);

    // Reading messages for the thread during active processing:
    const messages = getQueuedMessagesForThread(threadId);

    // BUG: If it only checks 'pending', messages.length will be 0 and message vanishes!
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("Temporary vanish message");
    dbFallbackQueue.clear();
  });

  it("VULN-3a: extractRetryAfterMs fails on standard Web Headers instance", () => {
    const headers = new Headers();
    headers.set("retry-after", "15");
    const err = { headers };

    const extracted = extractRetryAfterMs(err);
    expect(extracted).toBe(15000);
  });

  it("VULN-3b: calculateFullJitterBackoff ignores maxMs ceiling when Retry-After is huge", () => {
    // 24 hours Retry-After header
    const delay = calculateFullJitterBackoff(1, 500, 5000, 86400000);
    // Should be clamped to maxMs (5000ms), NOT 86400200ms!
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it("VULN-4: Rate limiter headers - X-RateLimit-Reset must be Unix timestamp in seconds", async () => {
    const app = await createApp(true);
    const res = await app.handle(
      new Request("http://localhost/v2/ask", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-rate-limit": "true",
          "x-forwarded-for": "1.2.3.4",
        },
        body: JSON.stringify({ widgetId: "test", message: "hi" }),
      })
    );

    // On allowed request, x-ratelimit-reset should be present and be a unix epoch timestamp (> 1_700_000_000)
    const resetHeader = res.headers.get("x-ratelimit-reset");
    expect(resetHeader).toBeDefined();
    expect(Number(resetHeader)).toBeGreaterThan(1_700_000_000);
  });

  it("VULN-5: Relative URL with base URL resolution maps to correct policy tier", async () => {
    const rawUrl = "/v2/ask?session=xyz";
    const pathname = new URL(rawUrl, "http://localhost").pathname;
    const policy = resolvePolicy(pathname, "POST");
    expect(policy.tier).toBe("ask");
    expect(policy.limit).toBe(10);
  });

  it("VULN-6: Priority eviction of failed jobs over pending jobs on capacity limit", () => {
    const queue = new FallbackQueue<number>("test-evict", 3);
    const j1 = queue.enqueue(1);
    const j2 = queue.enqueue(2);
    const j3 = queue.enqueue(3);

    // Fail j2 permanently
    j2.attempts = 5;
    j2.status = "failed";

    // Now enqueue j4 when capacity (3) is full
    queue.enqueue(4);

    // The failed job (j2) should be evicted FIRST, NOT j1 (which is still pending)!
    expect(queue.get(j2.id)).toBeUndefined();
    expect(queue.get(j1.id)).toBeDefined();
    expect(queue.get(j3.id)).toBeDefined();
  });

  it("VULN-7: extractClientIp is vulnerable to X-Forwarded-For spoofing over CF-Connecting-IP", () => {
    const req = new Request("http://localhost", {
      headers: {
        "cf-connecting-ip": "203.0.113.1",
        "x-forwarded-for": "198.51.100.99, 10.0.0.1",
      },
    });

    // Cloudflare edge IP must be preferred over untrusted client-supplied X-Forwarded-For
    const ip = extractClientIp(req);
    expect(ip).toBe("203.0.113.1");
  });

  it("VULN-8: processPending does not burn retries in tight infinite loop on failure", async () => {
    const queue = new FallbackQueue<number>("test-burn", 10);
    const job = queue.enqueue(42, { initialDelayMs: 0 });

    // When processPending runs with a future timestamp, a failing job should only be attempted ONCE
    const report = await queue.processPending(async () => {
      return false; // failure
    }, Date.now() + 100000);

    expect(report.processed).toBe(1);
    expect(report.failed).toBe(1);
    expect(job.attempts).toBe(1); // NOT burned to 5!
    expect(job.status).toBe("pending"); // Still eligible for future retries
  });

  it("VULN-9: idempotencyMap is preserved when stale failed jobs are evicted", () => {
    const queue = new FallbackQueue<number>("test-idempotency-evict", 2);
    // 1. Enqueue Job 1 with key "k1"
    const j1 = queue.enqueue(1, { idempotencyKey: "k1" });
    // Fail j1 permanently
    j1.attempts = 5;
    j1.status = "failed";

    // 2. Client resubmits "k1", generating Job 2
    const j2 = queue.enqueue(2, { idempotencyKey: "k1" });
    expect(j2.id).not.toBe(j1.id);

    // 3. Queue hits capacity limit, evicting failed j1
    queue.enqueue(3);
    expect(queue.get(j1.id)).toBeUndefined(); // j1 evicted

    // 4. Client resubmits "k1" - must return j2 (NOT create duplicate j4)
    const j4 = queue.enqueue(4, { idempotencyKey: "k1" });
    expect(j4.id).toBe(j2.id);
  });

  it("VULN-10: extractClientIp normalizes ports, brackets, and empty comma tokens", () => {
    const req1 = new Request("http://localhost", {
      headers: { "x-forwarded-for": "198.51.100.5:8080" },
    });
    expect(extractClientIp(req1)).toBe("198.51.100.5");

    const req2 = new Request("http://localhost", {
      headers: { "x-forwarded-for": "  ,  , 198.51.100.7:9000 " },
    });
    expect(extractClientIp(req2)).toBe("198.51.100.7");

    const req3 = new Request("http://localhost", {
      headers: { "cf-connecting-ip": "[2001:db8::1]:443" },
    });
    expect(extractClientIp(req3)).toBe("2001:db8::1");
  });

  it("VULN-11: resolvePolicy normalizes trailing slashes and /api prefixes", () => {
    expect(resolvePolicy("/v2/ask/").tier).toBe("ask");
    expect(resolvePolicy("/api/v2/ask").tier).toBe("ask");
    expect(resolvePolicy("/api/v2/widget/create-thread/").tier).toBe("widget_thread");
  });

  it("VULN-12: calculateFullJitterBackoff safely handles NaN and negative attempts", () => {
    const delay1 = calculateFullJitterBackoff(NaN, 500, 5000);
    expect(Number.isFinite(delay1)).toBe(true);
    expect(delay1).toBeGreaterThanOrEqual(10);

    const delay2 = calculateFullJitterBackoff(-5, 500, 5000);
    expect(Number.isFinite(delay2)).toBe(true);
    expect(delay2).toBeGreaterThanOrEqual(10);
  });

  it("VULN-13: POST /v2/admin/mail/send deduplicates when Idempotency-Key is provided", async () => {
    process.env.ADMIN_TOKEN = "test-secret";
    process.env.NAVER_ID = "testuser";
    process.env.NAVER_APP_PASSWORD = "testpassword";

    const nodemailer = require("nodemailer");
    const origCreateTransport = nodemailer.createTransport;
    nodemailer.createTransport = () => ({
      sendMail: async () => {
        const err: any = new Error("421 4.7.0 Rate limit exceeded");
        err.responseCode = 421;
        throw err;
      },
      close: () => {},
      on: () => {},
    });

    try {
      const app = await createApp(true);
      const idempotencyKey = "mail-idem-" + Date.now();

      // Request 1
      const res1 = await app.handle(
        new Request("http://localhost/v2/admin/mail/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-secret",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            to: "client@test.com",
            subject: "Alert",
            text: "Server alert",
          }),
        })
      );
      expect(res1.status).toBe(202);
      const data1 = (await res1.json()) as any;

      // Request 2 with same idempotency-key
      const res2 = await app.handle(
        new Request("http://localhost/v2/admin/mail/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-secret",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            to: "client@test.com",
            subject: "Alert",
            text: "Server alert",
          }),
        })
      );
      expect(res2.status).toBe(202);
      const data2 = (await res2.json()) as any;

      // Both requests must return the exact same job ID (deduplicated)
      expect(data1.jobId).toBe(data2.jobId);
    } finally {
      nodemailer.createTransport = origCreateTransport;
    }
  });

  it("VULN-14: getQueuedMessagesForThread and chronological tail slicing retains freshest queued messages", () => {
    const threadId = "thread-50-cap-test";
    dbFallbackQueue.clear();

    for (let i = 0; i < 5; i++) {
      dbFallbackQueue.enqueue(
        {
          threadId,
          role: "user",
          content: `Queued message ${i}`,
          createdAt: new Date(Date.now() + i * 1000).toISOString(),
        },
        { type: "db_chat_message", initialDelayMs: 0 }
      );
    }

    const queued = getQueuedMessagesForThread(threadId);
    expect(queued.length).toBe(5);

    // Simulate 50 old messages merged with 5 fresh queued messages
    const oldMessages = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      thread_id: threadId,
      role: "user" as const,
      content: `Old message ${i}`,
      created_at: new Date(Date.now() - (60 - i) * 1000).toISOString(),
    }));

    let merged = [...oldMessages, ...queued];
    merged.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const limit = 50;
    if (merged.length > limit) {
      merged = merged.slice(-limit);
    }

    expect(merged.length).toBe(50);
    // The 5 freshest queued messages MUST be preserved at the tail
    expect(merged[49].content).toBe("Queued message 4");
    expect(merged[48].content).toBe("Queued message 3");
    expect(merged[47].content).toBe("Queued message 2");
    expect(merged[46].content).toBe("Queued message 1");
    expect(merged[45].content).toBe("Queued message 0");
    dbFallbackQueue.clear();
  });

  it("VULN-15: Cross-Origin (CORS) headers and expose-headers are attached on early 429 and 413 responses", async () => {
    resetRateLimitsForTesting();
    setTestRateLimitEnforced(true);
    const app = await createApp(true);
    const origin = "https://widget.client-site.com";

    // 1. Trigger rate limit (ask policy limit = 10)
    let rateLimitedRes: Response | null = null;
    for (let i = 0; i < 15; i++) {
      const res = await app.handle(
        new Request("http://localhost/v2/ask", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "origin": origin,
            "x-forwarded-for": "198.51.100.88",
            "x-test-rate-limit": "true",
          },
          body: JSON.stringify({ widgetId: "test", message: "hi" }),
        })
      );
      if (res.status === 429) {
        rateLimitedRes = res;
        break;
      }
    }

    expect(rateLimitedRes).not.toBeNull();
    expect(rateLimitedRes!.status).toBe(429);
    expect(rateLimitedRes!.headers.get("access-control-allow-origin")).toBe(origin);
    expect(rateLimitedRes!.headers.get("access-control-allow-credentials")).toBe("true");
    expect(rateLimitedRes!.headers.get("access-control-expose-headers")).toContain("retry-after");
    expect(rateLimitedRes!.headers.get("access-control-expose-headers")).toContain("x-ratelimit-reset");

    // 2. Trigger 413 Payload Too Large with CORS origin
    const largeRes = await app.handle(
      new Request("http://localhost/v2/ask", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "2000000",
          "origin": origin,
        },
        body: JSON.stringify({ widgetId: "test", message: "hi" }),
      })
    );
    expect(largeRes.status).toBe(413);
    expect(largeRes.headers.get("access-control-allow-origin")).toBe(origin);

    resetRateLimitsForTesting();
    setTestRateLimitEnforced(null);
  });

  it("VULN-16: normalizeIp handles IPv4-mapped IPv6 ports, zone identifiers, and surrounding quotes", () => {
    // IPv4-mapped IPv6 with port
    expect(normalizeIp("[::ffff:192.0.2.1]:8080")).toBe("::ffff:192.0.2.1");
    expect(normalizeIp("::ffff:192.0.2.1:8080")).toBe("::ffff:192.0.2.1");

    // Zone identifiers with port
    expect(normalizeIp("[fe80::1%eth0]:8080")).toBe("fe80::1%eth0");

    // Quoted IPs
    expect(normalizeIp('"198.51.100.1"')).toBe("198.51.100.1");
    expect(normalizeIp(" '198.51.100.2' ")).toBe("198.51.100.2");
  });

  it("VULN-17: extractClientIp accepts standard Web Headers instance directly", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "203.0.113.88");
    expect(extractClientIp(headers)).toBe("203.0.113.88");

    const cfHeaders = new Headers();
    cfHeaders.set("cf-connecting-ip", "203.0.113.99");
    expect(extractClientIp(cfHeaders)).toBe("203.0.113.99");
  });

  it("VULN-18: resolvePolicy collapses consecutive slashes and strips multiple trailing slashes", () => {
    expect(resolvePolicy("/v2/ask//").tier).toBe("ask");
    expect(resolvePolicy("/v2/ask///").tier).toBe("ask");
    expect(resolvePolicy("/v2//ask").tier).toBe("ask");
    expect(resolvePolicy("/API/v2/ask//").tier).toBe("ask");
    expect(resolvePolicy("/v2/widget//create-thread///").tier).toBe("widget_thread");
  });

  it("VULN-19: is429OrQuotaError handles string errors, string SMTP codes, and nested error objects", () => {
    // String errors (e.g. rejected promises)
    expect(is429OrQuotaError("429 Too Many Requests")).toBe(true);
    expect(is429OrQuotaError("Rate limit quota exceeded")).toBe(true);
    expect(is429OrQuotaError("User quota exceeded for today")).toBe(true);

    // String SMTP response codes
    expect(is429OrQuotaError({ responseCode: "421", message: "Service unavailable" })).toBe(true);
    expect(is429OrQuotaError({ code: "451", message: "Local processing error" })).toBe(true);

    // Nested error objects (Supabase / Axios formats)
    expect(is429OrQuotaError({ error: { message: "Too many requests, rate limit exceeded" } })).toBe(true);
    expect(is429OrQuotaError({ response: { data: { message: "Quota exceeded" } } })).toBe(true);
  });

  it("VULN-20: extractRetryAfterMs supports retryAfterSeconds and snake_case retry_after", () => {
    expect(extractRetryAfterMs({ retryAfterSeconds: 30 })).toBe(30000);
    expect(extractRetryAfterMs({ retry_after: 45 })).toBe(45000);
    expect(extractRetryAfterMs({ response: { data: { retry_after: 20 } } })).toBe(20000);
  });

  it("VULN-21: markProcessing does not revive failed or succeeded jobs", () => {
    const queue = new FallbackQueue<string>("test-resurrect", 10);
    const job = queue.enqueue("task-1");

    // Fail job permanently
    job.attempts = 5;
    job.status = "failed";

    // Attempting to mark failed job as processing must be rejected
    queue.markProcessing(job.id);
    expect(job.status).toBe("failed");
  });

  it("VULN-22: checkRateLimit returns ceiling resetEpochSec in test bypass mode", () => {
    const fixedNow = 1_700_000_123;
    const windowMs = 60_000;
    const res = checkRateLimit("test-key", 10, windowMs, { headers: {} }, fixedNow);
    expect(res.allowed).toBe(true);
    // (1_700_000_123 + 60_000) / 1000 = 1700060.123 -> Math.ceil = 1700061
    expect(res.resetEpochSec).toBe(1700061);
  });
});
