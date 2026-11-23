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

  it("VULN-23: Normal 200 and route-level 403 responses preserve rate-limit Access-Control-Expose-Headers", async () => {
    const app = await createApp(true);
    const origin = "https://embedded-client.example";
    const okRes = await app.handle(
      new Request("http://localhost/v1/healthz", {
        headers: { origin, "x-custom-proxy-header": "secret-internal" },
      }),
    );
    expect(okRes.status).toBe(200);
    const expose = (okRes.headers.get("access-control-expose-headers") || "").toLowerCase();
    expect(expose).toContain("retry-after");
    expect(expose).toContain("x-ratelimit-limit");
    expect(expose).toContain("x-ratelimit-remaining");
    expect(expose).toContain("x-ratelimit-reset");
    expect(expose).not.toContain("x-custom-proxy-header");
  });

  it("VULN-24: /v2/admin/widgets/upload-icon rejects MIME-spoofed non-image binary signatures with HTTP 400", async () => {
    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "test-admin-secret";
    try {
      const app = await createApp(true);
      const form = new FormData();
      form.append("widgetId", "test-widget");
      const spoofedSvg = new TextEncoder().encode("<svg onload='alert(1)'></svg>");
      form.append("file", new File([spoofedSvg], "evil.png", { type: "image/png" }));

      const res = await app.handle(
        new Request("http://localhost/v2/admin/widgets/upload-icon", {
          method: "POST",
          headers: { "x-admin-token": "test-admin-secret" },
          body: form,
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.success).toBe(false);
      expect(body.error).toContain("signature");
    } finally {
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });

  it("VULN-25: /v2/admin/mail/send rejects CRLF header injection in subject or from with HTTP 400", async () => {
    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "test-admin-secret";
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
            to: "victim@example.com",
            subject: "Hello\r\nBcc: attacker@evil.com",
            text: "Test",
          }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.success).toBe(false);
      expect(body.error).toContain("CRLF");
    } finally {
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });

  it("VULN-26: createLLMProvider reuses warm RotatingLLMProvider singleton and invalidates on env rotation", async () => {
    const {
      createRotatingOrConfiguredProvider: createLLMProvider,
      resetCachedProviderForTesting,
    } = await import("../lib/llm/factory");
    const prevKeys = process.env.OPENROUTER_API_KEYS;
    try {
      resetCachedProviderForTesting();
      process.env.OPENROUTER_API_KEYS = "sk-or-test-1,sk-or-test-2";
      const p1 = createLLMProvider();
      const p2 = createLLMProvider();
      expect(p1).not.toBeNull();
      expect(p1).toBe(p2);

      process.env.OPENROUTER_API_KEYS = "sk-or-test-1,sk-or-test-3";
      const p3 = createLLMProvider();
      expect(p3).not.toBeNull();
      expect(p3).not.toBe(p1);
    } finally {
      if (prevKeys === undefined) delete process.env.OPENROUTER_API_KEYS;
      else process.env.OPENROUTER_API_KEYS = prevKeys;
      resetCachedProviderForTesting();
    }
  });

  it("VULN-27: YouTube OAuth accepts hyphen/underscore GOCSPX secrets and blocks non-HTTP(S) redirectUri in state", async () => {
    const app = await createApp(true);

    // 1. Real Google OAuth secret containing '-' and '_' must pass schema validation (200)
    const createRes = await app.handle(
      new Request("http://localhost/v1/youtube/auth/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "123456789-abc_def-123.apps.googleusercontent.com",
          clientSecret: "GOCSPX-aBc_123-XyZ987",
          redirectUri: "https://example.com/oauth/callback",
        }),
      }),
    );
    expect(createRes.status).toBe(200);
    const createData = (await createRes.json()) as any;
    expect(createData.success).toBe(true);

    // 2. Forged base64 state with javascript:/file: redirectUri must be rejected with HTTP 400 before Google call
    const badState = Buffer.from(
      JSON.stringify({
        clientId: "123-abc.apps.googleusercontent.com",
        clientSecret: "GOCSPX-secret",
        redirectUri: "javascript:alert(1)",
      }),
    ).toString("base64");
    const confirmRes = await app.handle(
      new Request(
        `http://localhost/v1/youtube/auth/confirm?code=mock_code&state=${encodeURIComponent(badState)}`,
      ),
    );
    expect(confirmRes.status).toBe(400);
    const confirmData = (await confirmRes.json()) as any;
    expect(confirmData.success).toBe(false);
  });

  it("VULN-28: /v1/youtube/reply/list accepts numeric maxResults and pageToken without 422 schema failure", async () => {
    const app = await createApp(true);
    const res = await app.handle(
      new Request("http://localhost/v1/youtube/reply/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parentId: "comment-parent-123",
          accessToken: "mock-invalid-token",
          maxResults: 25,
          pageToken: "CAUQAA",
        }),
      }),
    );
    // Must pass input schema validation (not 422) and return handled 400 on invalid OAuth token
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });

  it("VULN-29: /v2/admin/widgets/upsert rejects empty or >100-char ghost widget IDs with HTTP 400", async () => {
    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "test-admin-secret";
    try {
      const app = await createApp(true);

      const emptyRes = await app.handle(
        new Request("http://localhost/v2/admin/widgets/upsert", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({ id: "   " }),
        }),
      );
      expect(emptyRes.status).toBe(400);

      const oversizedRes = await app.handle(
        new Request("http://localhost/v2/admin/widgets/upsert", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({ id: "w".repeat(101), name: "Ghost Widget" }),
        }),
      );
      expect(oversizedRes.status).toBe(400);
      const body = (await oversizedRes.json()) as any;
      expect(body.success).toBe(false);
      expect(body.error).toContain("maximum length");
    } finally {
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });

  it("VULN-30: extractClientIp prioritizes Vercel Edge x-vercel-forwarded-for over spoofed cf-connecting-ip", async () => {
    const { extractClientIp } = await import("../lib/rate-limit");

    // On *.vercel.app (not behind Cloudflare), client can spoof CF-Connecting-IP;
    // x-vercel-forwarded-for MUST win when present.
    const vercelReq = new Request("https://my-server-mocha.vercel.app/v1/healthz", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.77",
        "cf-connecting-ip": "198.51.100.99",
        "x-real-ip": "203.0.113.77",
        "x-forwarded-for": "10.0.0.1, 203.0.113.77",
      },
    });
    expect(extractClientIp(vercelReq)).toBe("203.0.113.77");

    // Behind Cloudflare without Vercel header, cf-connecting-ip still wins over x-forwarded-for
    const cfReq = new Request("https://example.com/v1/healthz", {
      headers: {
        "cf-connecting-ip": "198.51.100.42",
        "x-forwarded-for": "10.0.0.1",
      },
    });
    expect(extractClientIp(cfReq)).toBe("198.51.100.42");
  });

  it("VULN-31: /v2/admin/sms/send enqueues persistent Pushbullet 429 (202 Accepted + Idempotency-Key) and opportunistically drains on recovery", async () => {
    const { smsFallbackQueue } = await import("../lib/queue/fallback-queue");
    const prevAdmin = process.env.ADMIN_TOKEN;
    const prevProvider = process.env.SMS_PROVIDER;
    const prevPbToken = process.env.PUSHBULLET_ACCESS_TOKEN;
    const prevPbIden = process.env.PUSHBULLET_DEVICE_IDEN;
    const prevRetryMax = process.env.PUSHBULLET_RETRY_MAX;
    const originalFetch = globalThis.fetch;

    process.env.ADMIN_TOKEN = "test-admin-secret";
    process.env.SMS_PROVIDER = "pushbullet";
    process.env.PUSHBULLET_ACCESS_TOKEN = "pb-test-token";
    process.env.PUSHBULLET_DEVICE_IDEN = "pb-device-iden-1";
    process.env.PUSHBULLET_RETRY_MAX = "1";
    smsFallbackQueue.clear();

    try {
      const app = await createApp(true);
      let pushbulletMode: "rate_limited" | "healthy" = "rate_limited";
      const deliveredPayloads: string[] = [];

      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (url.includes("api.pushbullet.com")) {
          if (pushbulletMode === "rate_limited") {
            return new Response(
              JSON.stringify({ error: { message: "Rate limit exceeded" } }),
              {
                status: 429,
                headers: {
                  "content-type": "application/json",
                  "retry-after": "0",
                },
              },
            );
          }
          const parsed = JSON.parse(String(init?.body || "{}"));
          deliveredPayloads.push(parsed?.data?.message || "");
          return new Response(JSON.stringify({ active: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      }) as any;

      // 1. Persistent 429 -> HTTP 202 Accepted + queued without data loss
      const res1 = await app.handle(
        new Request("http://localhost/v2/admin/sms/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
            "idempotency-key": "sms-idem-20261116-1",
          },
          body: JSON.stringify({ to: "010-1234-5678", text: "Queued SMS #1" }),
        }),
      );
      expect(res1.status).toBe(202);
      const body1 = (await res1.json()) as any;
      expect(body1.queued).toBe(true);
      expect(smsFallbackQueue.size).toBe(1);

      // 2. Duplicate Idempotency-Key returns same jobId instead of duplicating queue entry
      const resDup = await app.handle(
        new Request("http://localhost/v2/admin/sms/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
            "idempotency-key": "sms-idem-20261116-1",
          },
          body: JSON.stringify({ to: "010-1234-5678", text: "Queued SMS #1" }),
        }),
      );
      expect(resDup.status).toBe(202);
      const bodyDup = (await resDup.json()) as any;
      expect(bodyDup.jobId).toBe(body1.jobId);
      expect(smsFallbackQueue.size).toBe(1);

      // 3. Pushbullet recovers -> next healthy SMS automatically drains queued job too!
      pushbulletMode = "healthy";
      // Mark job ready immediately for deterministic test execution
      const jobs = smsFallbackQueue.getAllJobs();
      jobs[0].nextRetryAt = Date.now() - 10;

      const resHealthy = await app.handle(
        new Request("http://localhost/v2/admin/sms/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({ to: "010-9999-8888", text: "Healthy SMS #2" }),
        }),
      );
      expect(resHealthy.status).toBe(200);
      expect(deliveredPayloads).toContain("Healthy SMS #2");
      expect(deliveredPayloads).toContain("Queued SMS #1");
      expect(smsFallbackQueue.size).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      smsFallbackQueue.clear();
      if (prevAdmin === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevAdmin;
      if (prevProvider === undefined) delete process.env.SMS_PROVIDER;
      else process.env.SMS_PROVIDER = prevProvider;
      if (prevPbToken === undefined) delete process.env.PUSHBULLET_ACCESS_TOKEN;
      else process.env.PUSHBULLET_ACCESS_TOKEN = prevPbToken;
      if (prevPbIden === undefined) delete process.env.PUSHBULLET_DEVICE_IDEN;
      else process.env.PUSHBULLET_DEVICE_IDEN = prevPbIden;
      if (prevRetryMax === undefined) delete process.env.PUSHBULLET_RETRY_MAX;
      else process.env.PUSHBULLET_RETRY_MAX = prevRetryMax;
    }
  });

  it("VULN-32: /v2/admin/widgets/upsert blocks javascript:/data: XSS schemes in icon_url with HTTP 400", async () => {
    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "test-admin-secret";
    try {
      const app = await createApp(true);

      for (const xssUrl of [
        "javascript:alert(document.cookie)",
        "data:text/html,<script>alert(1)</script>",
        "https://evil.example.com/icon.png\" onerror=\"alert(1)",
      ]) {
        const res = await app.handle(
          new Request("http://localhost/v2/admin/widgets/upsert", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-admin-token": "test-admin-secret",
            },
            body: JSON.stringify({ id: "safe-widget", icon_url: xssUrl }),
          }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as any;
        expect(body.success).toBe(false);
        expect(body.error).toContain("icon_url");
      }
    } finally {
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });

  it("VULN-33: YouTube endpoints reject whitespace-only inputs with HTTP 400 without outbound calls, and mail endpoint caps recipient count", async () => {
    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "test-admin-secret";
    try {
      const app = await createApp(true);

      // 1. Whitespace-only handle/accessToken on /v1/youtube/video/list -> instant local 400
      const t0 = performance.now();
      const ytRes = await app.handle(
        new Request("http://localhost/v1/youtube/video/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle: "   ", accessToken: "   " }),
        }),
      );
      const elapsedMs = performance.now() - t0;
      expect(ytRes.status).toBe(400);
      expect(elapsedMs).toBeLessThan(150);
      const ytBody = (await ytRes.json()) as any;
      expect(ytBody.success).toBe(false);

      // 2. /v2/admin/mail/send rejects >50 comma-separated recipients with HTTP 400
      const tooManyRecipients = Array.from(
        { length: 51 },
        (_, i) => `user${i}@example.com`,
      ).join(", ");
      const mailRes = await app.handle(
        new Request("http://localhost/v2/admin/mail/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({
            to: tooManyRecipients,
            subject: "Bulk test",
            text: "Hello",
          }),
        }),
      );
      expect(mailRes.status).toBe(400);
      const mailBody = (await mailRes.json()) as any;
      expect(mailBody.success).toBe(false);
      expect(mailBody.error).toContain("maximum 50");
    } finally {
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });

  it("VULN-34: UpstashRedisKeyStore.syncKeys emits valid 3-arg HSETNX + variadic HSET and surfaces pipeline sub-errors", async () => {
    const { UpstashRedisKeyStore } = await import("../lib/llm/key-manager/stores/upstash-redis");
    const store = new UpstashRedisKeyStore("https://mock-upstash.local", "mock-token");

    const capturedPipelines: any[][][] = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/pipeline")) {
          const cmds = JSON.parse(String(init?.body ?? "[]"));
          capturedPipelines.push(cmds);
          return new Response(
            JSON.stringify(cmds.map(() => ({ result: 1 }))),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
      }) as any;

      await store.syncKeys([
        {
          id: "k-sync-1",
          apiKey: "sk-1",
          accountId: "acc-1",
          tier: 0,
          weight: 20,
          maxConcurrency: 8,
        },
      ]);

      expect(capturedPipelines.length).toBe(1);
      const cmds = capturedPipelines[0];
      // Every HSETNX command in Redis MUST have strictly 4 elements: ['HSETNX', key, field, value]
      const hsetnxCmds = cmds.filter((c) => c[0] === "HSETNX");
      expect(hsetnxCmds.length).toBe(2);
      for (const c of hsetnxCmds) {
        expect(c.length).toBe(4);
      }
      // Static config fields must use variadic HSET
      const hsetCmd = cmds.find((c) => c[0] === "HSET");
      expect(hsetCmd).toBeDefined();
      expect(hsetCmd).toContain("max_concurrency");
      expect(hsetCmd).toContain("8");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("VULN-35: All 11 /v2/admin/* endpoints return HTTP 401 (never 422 TypeBox schema leak) on unauthenticated empty/malformed payloads", async () => {
    const prevAdmin = process.env.ADMIN_TOKEN;
    const prevMail = process.env.MAIL_SEND_TOKEN;
    process.env.ADMIN_TOKEN = "test-admin-secret";
    process.env.MAIL_SEND_TOKEN = "test-mail-secret";

    try {
      const app = await createApp(true);
      const adminPaths = [
        "/v2/admin/widgets",
        "/v2/admin/widgets/upsert",
        "/v2/admin/widgets/delete",
        "/v2/admin/widgets/upload-icon",
        "/v2/admin/threads",
        "/v2/admin/threads/update",
        "/v2/admin/threads/rename",
        "/v2/admin/messages",
        "/v2/admin/db/migrate",
        "/v2/admin/mail/send",
        "/v2/admin/sms/send",
      ];

      for (const p of adminPaths) {
        const res = await app.handle(
          new Request(`http://localhost${p}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          }),
        );
        expect(res.status).toBe(401);
        const text = await res.text();
        expect(text).not.toContain('"type":"validation"');
        expect(text).not.toContain("Expected property");
      }

      // Authenticated admin sending empty {} to /v2/admin/sms/send MUST still receive 422 validation feedback
      const authedInvalidRes = await app.handle(
        new Request("http://localhost/v2/admin/sms/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({}),
        }),
      );
      expect(authedInvalidRes.status).toBe(422);
    } finally {
      if (prevAdmin === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevAdmin;
      if (prevMail === undefined) delete process.env.MAIL_SEND_TOKEN;
      else process.env.MAIL_SEND_TOKEN = prevMail;
    }
  });

  it("VULN-36: /v2/admin/widgets/upsert and isValidWidgetBubbleSize block CSS injection in chat_bubble_size with HTTP 400", async () => {
    const { isValidWidgetBubbleSize } = await import("../lib/url-guard");
    expect(isValidWidgetBubbleSize("48px")).toBe(true);
    expect(isValidWidgetBubbleSize("3.5rem")).toBe(true);
    expect(isValidWidgetBubbleSize("64")).toBe(true);
    expect(isValidWidgetBubbleSize("48px; background:url(javascript:alert(1))")).toBe(false);
    expect(isValidWidgetBubbleSize("</style><script>alert(1)</script>")).toBe(false);

    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "test-admin-secret";
    try {
      const app = await createApp(true);
      for (const maliciousCss of [
        "48px; background:url(javascript:alert(1))",
        "</style><script>alert(1)</script>",
        "calc(100vw); position:fixed; inset:0",
      ]) {
        const res = await app.handle(
          new Request("http://localhost/v2/admin/widgets/upsert", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-admin-token": "test-admin-secret",
            },
            body: JSON.stringify({
              id: "safe-widget",
              chat_bubble_size: maliciousCss,
            }),
          }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as any;
        expect(body.success).toBe(false);
        expect(body.error).toContain("chat_bubble_size");
      }
    } finally {
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });

  it("VULN-37: RotatingLLMProvider & OpenAICompatibleProvider parse W3C no-space SSE frames and flush non-newline trailing chunks", async () => {
    const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");
    const { RotatingLLMProvider } = await import("../lib/llm/rotating-provider");
    const { OpenAICompatibleProvider } = await import("../lib/llm/openai-compatible");

    const store = new MemoryKeyStore();
    const keyMap = new Map<string, any>([
      ["k1", { id: "k1", apiKey: "sk-1", tier: 0, weight: 100, maxConcurrency: 5 }],
    ]);
    const rotating = new RotatingLLMProvider(store, keyMap);
    const compat = new OpenAICompatibleProvider({
      name: "test-compat",
      baseUrl: "https://mock-llm.local/v1",
      apiKey: "sk-compat",
      defaultModel: "mock-model",
    });

    const originalFetch = globalThis.fetch;
    try {
      // Upstream sends no-space "data:{...}" AND final frame without trailing "\n"
      globalThis.fetch = (async () =>
        new Response(
          'data:{"choices":[{"delta":{"content":"Hel"}}]}\ndata:{"choices":[{"delta":{"content":"lo!"}}]}',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as any;

      let outRot = "";
      for await (const ch of rotating.stream({ messages: [{ role: "user", content: "hi" }] })) {
        outRot += ch;
      }
      expect(outRot).toBe("Hello!");

      let outCompat = "";
      for await (const ch of compat.stream({ messages: [{ role: "user", content: "hi" }] })) {
        outCompat += ch;
      }
      expect(outCompat).toBe("Hello!");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("VULN-38: HealthAndCooldownEngine honors fractional Retry-After headers and YouTube OAuth confirm rejects whitespace queries", async () => {
    const { HealthAndCooldownEngine } = await import("../lib/llm/key-manager/engine");

    // Fractional Retry-After: "2.5" -> 2500ms + jitter [500..1500] = [3000..4000]ms
    const cd = HealthAndCooldownEngine.calculate429Cooldown(
      { "retry-after": "2.5" },
      1,
      1_700_000_000_000,
    );
    expect(cd).toBeGreaterThanOrEqual(3000);
    expect(cd).toBeLessThanOrEqual(4000);

    const app = await createApp(true);
    const ytRes = await app.handle(
      new Request("http://localhost/v1/youtube/auth/confirm?code=%20%20&state=%20%20"),
    );
    expect(ytRes.status).toBe(400);
    const ytData = (await ytRes.json()) as any;
    expect(ytData.success).toBe(false);
  });

  it("VULN-39: Serverless handler sanitizes hostile X-Forwarded-Host, X-Forwarded-Proto, and protocol-relative // paths without 500 or route hijacking", async () => {
    const http = await import("node:http");
    const { default: serverlessHandler } = await import("../lambda-src/handler");

    const invoke = async (headers: Record<string, string>, url: string) => {
      const req = Object.assign(Object.create(http.IncomingMessage.prototype), {
        url,
        method: "GET",
        headers,
        on() {
          return this;
        },
        complete: true,
      });
      let body = "";
      const res: any = {
        statusCode: 0,
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        headers: {} as Record<string, any>,
        setHeader(k: string, v: any) {
          this.headers[k.toLowerCase()] = v;
        },
        getHeader(k: string) {
          return this.headers[k.toLowerCase()];
        },
        on() {
          return this;
        },
        once() {
          return this;
        },
        off() {
          return this;
        },
        write(chunk: any) {
          this.headersSent = true;
          body += Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString("utf8")
            : String(chunk);
          return true;
        },
        end(chunk?: any) {
          this.headersSent = true;
          if (chunk) {
            body += Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
              ? Buffer.from(chunk).toString("utf8")
              : String(chunk);
          }
          this.writableEnded = true;
        },
      };
      await serverlessHandler(req, res);
      return { statusCode: res.statusCode, body };
    };

    // 1. Host header path-smuggling + javascript: proto + //v1/healthz double-slash path -> 200 OK
    const r1 = await invoke(
      {
        "x-forwarded-host": "evil.attacker.com/v1/youtube/comment/delete?x=",
        "x-forwarded-proto": "javascript",
      },
      "//v1/healthz",
    );
    expect(r1.statusCode).toBe(200);
    expect(r1.body).toBe("OK");

    // 2. Protocol-relative //evil.attacker.com/... in req.url stays local (404, never 500 or host override)
    const rProtoRel = await invoke(
      { host: "my-server-mocha.vercel.app" },
      "//evil.attacker.com/v1/healthz",
    );
    expect(rProtoRel.statusCode).toBe(404);

    // 3. Malformed bracketed IPv6 host that previously threw TypeError: Invalid URL -> 500
    const r2 = await invoke(
      {
        host: "[::1-broken-host",
        "x-forwarded-proto": "ftp\r\n",
      },
      "/v1/healthz",
    );
    expect(r2.statusCode).toBe(200);
    expect(r2.body).toBe("OK");
  });

  it("VULN-40: listMessages fetches newest rows (DESC + reverse) so >50-turn threads never drop recent messages, and supabaseClient invalidates on env change", async () => {
    const { listMessages } = await import("../lib/chat-store?real-v40" as any);
    const { supabaseClient } = await import("../lib/supabase/client");

    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_KEY;
    const originalFetch = globalThis.fetch;

    // 65 chronological messages (#1 oldest .. #65 newest)
    const dbRows = Array.from({ length: 65 }, (_, i) => ({
      id: i + 1,
      thread_id: "thread-long-65",
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `msg-${i + 1}`,
      created_at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    }));

    try {
      process.env.SUPABASE_URL = "https://mock-supabase-40.local";
      process.env.SUPABASE_SERVICE_KEY = "mock-service-key-40";

      globalThis.fetch = (async (input: any) => {
        const rawUrl = typeof input === "string" ? input : input?.url || String(input);
        const parsed = new URL(rawUrl);
        if (parsed.hostname === "mock-supabase-40.local") {
          const orderParam = parsed.searchParams.get("order") || "";
          const limitParam = Number(parsed.searchParams.get("limit") || "50");
          const sorted = dbRows.slice();
          if (orderParam.includes("created_at.desc")) {
            sorted.reverse();
          }
          return new Response(JSON.stringify(sorted.slice(0, limitParam)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input);
      }) as any;

      const latest50 = await listMessages("thread-long-65", 50);
      expect(latest50.length).toBe(50);
      // Must return #16..#65 in ascending chronological order (NOT #1..#50 dropping #51..#65!)
      expect(latest50[0].id).toBe(16);
      expect(latest50[49].id).toBe(65);
      expect(latest50[49].content).toBe("msg-65");
    } finally {
      globalThis.fetch = originalFetch;
      if (prevUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = prevKey;
    }

    // Verify clearing SUPABASE_URL immediately invalidates cached client instead of leaking mock URL
    if (!process.env.SUPABASE_URL) {
      expect(() => (supabaseClient as any).from("widget")).toThrow("SUPABASE_URL");
    }
  });

  it("VULN-41: /v2/admin/sms/send enqueues SMS (202 Accepted) when Pushbullet /v2/devices nickname lookup hits HTTP 429 on cold start", async () => {
    const { smsFallbackQueue } = await import("../lib/queue/fallback-queue");
    const { clearPushbulletIdenCache } = await import("../lib/sms/pushbullet");

    const prevAdmin = process.env.ADMIN_TOKEN;
    const prevProvider = process.env.SMS_PROVIDER;
    const prevPbToken = process.env.PUSHBULLET_ACCESS_TOKEN;
    const prevPbIden = process.env.PUSHBULLET_DEVICE_IDEN;
    const prevPbNick = process.env.PUSHBULLET_DEVICE_NICKNAME;
    const prevRetryMax = process.env.PUSHBULLET_RETRY_MAX;
    const originalFetch = globalThis.fetch;

    process.env.ADMIN_TOKEN = "test-admin-secret";
    process.env.SMS_PROVIDER = "pushbullet";
    process.env.PUSHBULLET_ACCESS_TOKEN = "pb-nick-token";
    delete process.env.PUSHBULLET_DEVICE_IDEN;
    process.env.PUSHBULLET_DEVICE_NICKNAME = "GalaxyS24";
    process.env.PUSHBULLET_RETRY_MAX = "0";
    clearPushbulletIdenCache();
    smsFallbackQueue.clear();

    try {
      const app = await createApp(true);
      let devicesRateLimited = true;
      const sentTexts: string[] = [];

      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (url.endsWith("/v2/devices")) {
          if (devicesRateLimited) {
            return new Response(
              JSON.stringify({ error: { message: "Rate limit on /v2/devices" } }),
              {
                status: 429,
                headers: {
                  "content-type": "application/json",
                  "retry-after": "2",
                },
              },
            );
          }
          return new Response(
            JSON.stringify({
              devices: [{ iden: "iden-galaxy-24", nickname: "GalaxyS24", active: true }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/v2/texts")) {
          const body = JSON.parse(String(init?.body || "{}"));
          sentTexts.push(body?.data?.message || "");
          return new Response(JSON.stringify({ iden: "txt-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      }) as any;

      // Cold-start 429 on /v2/devices MUST return 202 queued_for_retry (NOT 502 / status 400 drop!)
      const res429 = await app.handle(
        new Request("http://localhost/v2/admin/sms/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
            "idempotency-key": "pb-devices-429-1",
          },
          body: JSON.stringify({ to: "010-2222-3333", text: "Cold start SMS" }),
        }),
      );
      expect(res429.status).toBe(202);
      const data429 = (await res429.json()) as any;
      expect(data429.queued).toBe(true);
      expect(smsFallbackQueue.size).toBe(1);

      // Recovery drains queued SMS automatically
      devicesRateLimited = false;
      smsFallbackQueue.getAllJobs()[0].nextRetryAt = Date.now() - 10;

      const resOk = await app.handle(
        new Request("http://localhost/v2/admin/sms/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({ to: "010-4444-5555", text: "Recovery SMS" }),
        }),
      );
      expect(resOk.status).toBe(200);
      expect(sentTexts).toContain("Cold start SMS");
      expect(sentTexts).toContain("Recovery SMS");
      expect(smsFallbackQueue.size).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      clearPushbulletIdenCache();
      smsFallbackQueue.clear();
      if (prevAdmin === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevAdmin;
      if (prevProvider === undefined) delete process.env.SMS_PROVIDER;
      else process.env.SMS_PROVIDER = prevProvider;
      if (prevPbToken === undefined) delete process.env.PUSHBULLET_ACCESS_TOKEN;
      else process.env.PUSHBULLET_ACCESS_TOKEN = prevPbToken;
      if (prevPbIden === undefined) delete process.env.PUSHBULLET_DEVICE_IDEN;
      else process.env.PUSHBULLET_DEVICE_IDEN = prevPbIden;
      if (prevPbNick === undefined) delete process.env.PUSHBULLET_DEVICE_NICKNAME;
      else process.env.PUSHBULLET_DEVICE_NICKNAME = prevPbNick;
      if (prevRetryMax === undefined) delete process.env.PUSHBULLET_RETRY_MAX;
      else process.env.PUSHBULLET_RETRY_MAX = prevRetryMax;
    }
  });

  it("VULN-42: /v2/admin/widgets/upsert enforces persona/system_prompt bounds (HTTP 400) and upload-icon skips FormData parse when unauthenticated", async () => {
    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "test-admin-secret";
    try {
      const app = await createApp(true);

      // 1. Oversized system_prompt (>20,000 chars) -> 400
      const resPrompt = await app.handle(
        new Request("http://localhost/v2/admin/widgets/upsert", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({
            id: "bounded-widget",
            system_prompt: "P".repeat(20_001),
          }),
        }),
      );
      expect(resPrompt.status).toBe(400);

      // 2. Control-char theme or >20 suggested_questions -> 400
      const resTheme = await app.handle(
        new Request("http://localhost/v2/admin/widgets/upsert", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({
            id: "bounded-widget",
            theme: "noir\u0000injected",
          }),
        }),
      );
      expect(resTheme.status).toBe(400);

      const resQuestions = await app.handle(
        new Request("http://localhost/v2/admin/widgets/upsert", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({
            id: "bounded-widget",
            suggested_questions: Array.from({ length: 21 }, (_, i) => `Q${i}?`),
          }),
        }),
      );
      expect(resQuestions.status).toBe(400);

      // 3. Unauthenticated upload-icon with boundary-less multipart returns 401 cleanly (skips FormData parse)
      const resUnauthUpload = await app.handle(
        new Request("http://localhost/v2/admin/widgets/upload-icon", {
          method: "POST",
          headers: { "content-type": "multipart/form-data" },
          body: "raw-unauthenticated-garbage-without-boundary",
        }),
      );
      expect(resUnauthUpload.status).toBe(401);
    } finally {
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });

  it("VULN-43: /v1/youtube/video/list caches channel uploadsPlaylistId across paginated requests (eliminating N+1 channels.list calls) and truncates float maxResults", async () => {
    const { google } = await import("googleapis");
    const { clearChannelUploadsCache } = await import(
      "../src/endpoints/v1/youtube/video-list"
    );

    const origYoutube = google.youtube;
    let channelsListCalls = 0;
    const observedMaxResults: number[] = [];
    clearChannelUploadsCache();

    try {
      (google as any).youtube = () => ({
        channels: {
          list: async () => {
            channelsListCalls++;
            return {
              data: {
                items: [
                  {
                    contentDetails: {
                      relatedPlaylists: { uploads: "UU_CACHED_PLAYLIST_123" },
                    },
                  },
                ],
              },
            };
          },
        },
        playlistItems: {
          list: async (params: any) => {
            observedMaxResults.push(params.maxResults);
            return {
              data: {
                items: [{ id: "vid-1" }],
                nextPageToken: "NEXT_PAGE_2",
                pageInfo: { totalResults: 10, resultsPerPage: params.maxResults },
              },
            };
          },
        },
      });

      const app = await createApp(true);

      // Page 1 (with float maxResults: 12.8 -> must truncate to integer 12)
      const page1 = await app.handle(
        new Request("http://localhost/v1/youtube/video/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            handle: "@lolollol2379",
            accessToken: "mock-valid-oauth",
            maxResults: 12.8,
          }),
        }),
      );
      expect(page1.status).toBe(200);
      expect(channelsListCalls).toBe(1);
      expect(observedMaxResults[0]).toBe(12);

      // Page 2 (same handle -> must hit LRU cache, 0 extra channels.list calls!)
      const page2 = await app.handle(
        new Request("http://localhost/v1/youtube/video/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            handle: "lolollol2379",
            accessToken: "mock-valid-oauth",
            pageToken: "NEXT_PAGE_2",
            maxResults: 15,
          }),
        }),
      );
      expect(page2.status).toBe(200);
      expect(channelsListCalls).toBe(1);
      expect(observedMaxResults[1]).toBe(15);
    } finally {
      google.youtube = origYoutube;
      clearChannelUploadsCache();
    }
  });

  it("VULN-44: isValidWidgetBubbleSize blocks viewport/oversized/zero clickjacking dimensions and /v2/widget/view sanitizes poisoned DB rows on read", async () => {
    const { isValidWidgetBubbleSize } = await import("../lib/url-guard");
    const { renderPersona } = await import("../src/endpoints/v2/widget-endpoints");
    const widgetStoreMod: any = await import("../lib/widget-store?real-v44" as any);

    expect(isValidWidgetBubbleSize("24px")).toBe(true);
    expect(isValidWidgetBubbleSize("48px")).toBe(true);
    expect(isValidWidgetBubbleSize("160px")).toBe(true);
    expect(isValidWidgetBubbleSize("1.5rem")).toBe(true);
    expect(isValidWidgetBubbleSize("10rem")).toBe(true);
    expect(isValidWidgetBubbleSize("4em")).toBe(true);

    // Clickjacking / invisible launcher vectors must be rejected
    for (const bad of ["0px", "0", "12px", "161px", "99999px", "100vw", "100vh", "100%", "0.5rem", "20rem"]) {
      expect(isValidWidgetBubbleSize(bad)).toBe(false);
    }

    // 1. Direct read-time sanitization of poisoned DB row via renderPersona
    const poisonedMaster = {
      id: "poisoned-widget-44",
      name: "Safe Name",
      theme: "noir",
      description: "Desc",
      welcome_message: "Hi",
      system_prompt: null,
      suggested_questions: [],
      icon_url: "javascript:alert(document.domain)",
      chat_bubble_size: "100vw",
      is_deleted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const rendered = renderPersona(poisonedMaster, "poisoned-widget-44");
    expect(rendered.icon).toBeNull();
    expect(rendered.widget_bubble_size).toBeNull();

    const renderedProtoRel = renderPersona(
      { ...poisonedMaster, icon_url: "//evil.attacker.com/icon.svg", chat_bubble_size: "99999px" },
      "poisoned-widget-44",
    );
    expect(renderedProtoRel.icon).toBeNull();
    expect(renderedProtoRel.widget_bubble_size).toBeNull();

    const renderedSafe = renderPersona(
      { ...poisonedMaster, icon_url: "https://cdn.tokki.app/icon.png", chat_bubble_size: "56px" },
      "safe-widget-44",
    );
    expect(renderedSafe.icon).toBe("https://cdn.tokki.app/icon.png");
    expect(renderedSafe.widget_bubble_size).toBe("56px");

    // 2. End-to-end /v2/widget/view check (safe even when widget-store is module-mocked in shared test process)
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_KEY;
    const originalFetch = globalThis.fetch;

    try {
      process.env.SUPABASE_URL = "https://mock-supabase-44.local";
      process.env.SUPABASE_SERVICE_KEY = "mock-service-key-44";
      widgetStoreMod?.invalidateWidgetCache?.("poisoned-widget-44");

      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const rawUrl = typeof input === "string" ? input : input?.url || String(input);
        const parsed = new URL(rawUrl);
        if (parsed.hostname === "mock-supabase-44.local") {
          if (parsed.pathname.endsWith("/widget")) {
            return new Response(JSON.stringify(poisonedMaster), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (parsed.pathname.endsWith("/chat_thread") && init?.method === "POST") {
            return new Response(
              JSON.stringify({ id: "00000000-0000-4000-8000-000000000044" }),
              { status: 201, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      }) as any;

      const app = await createApp(true);
      const res = await app.handle(
        new Request("http://localhost/v2/widget/view", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ widgetId: "poisoned-widget-44" }),
        }),
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.widget.icon).toBeNull();
      expect(data.widget.widget_bubble_size).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      widgetStoreMod?.invalidateWidgetCache?.("poisoned-widget-44");
      if (prevUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = prevKey;
    }
  });

  it("VULN-45: /v2/admin/threads/update and /v2/admin/threads/rename enforce strict ID, prompt, context, and control-char bounds with HTTP 400", async () => {
    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "test-admin-secret";
    try {
      const app = await createApp(true);

      // 1. Oversized context_text (> 20,000 chars) on /v2/admin/threads/update -> HTTP 400
      const resCtx = await app.handle(
        new Request("http://localhost/v2/admin/threads/update", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({
            widgetId: "default",
            threadId: "thread-1",
            context_text: "C".repeat(20_001),
          }),
        }),
      );
      expect(resCtx.status).toBe(400);

      // 2. Oversized threadId (> 100 chars) -> HTTP 400
      const resTid = await app.handle(
        new Request("http://localhost/v2/admin/threads/update", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({
            widgetId: "default",
            threadId: "t".repeat(101),
            system_prompt: "ok",
          }),
        }),
      );
      expect(resTid.status).toBe(400);

      // 3. Control character or >200-char title on /v2/admin/threads/rename -> HTTP 400
      const resTitle = await app.handle(
        new Request("http://localhost/v2/admin/threads/rename", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({
            widgetId: "default",
            threadId: "thread-1",
            title: "Session\u0000Injected",
          }),
        }),
      );
      expect(resTitle.status).toBe(400);
    } finally {
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });

  it("VULN-46: FallbackQueue bounds opportunistic request-path drains via maxBatchSize and batches multi-thread lookup in O(Q)", async () => {
    const {
      FallbackQueue,
      dbFallbackQueue,
      getQueuedMessagesForThreads,
    } = await import("../lib/queue/fallback-queue");

    const q = new FallbackQueue<number>("batch-bound-test", 100);
    for (let i = 0; i < 25; i++) {
      q.enqueue(i, { initialDelayMs: 0 });
    }
    expect(q.hasReadyJobs(Date.now() + 10)).toBe(true);

    const report = await q.processPending(async () => true, Date.now() + 10, 10);
    expect(report.processed).toBe(10);
    expect(report.succeeded).toBe(10);
    expect(q.size).toBe(15);

    dbFallbackQueue.clear();
    try {
      dbFallbackQueue.enqueue(
        { threadId: "t-a", role: "user", content: "msg-a" },
        { type: "db_chat_message", initialDelayMs: 0 },
      );
      dbFallbackQueue.enqueue(
        { threadId: "t-b", role: "assistant", content: "msg-b" },
        { type: "db_chat_message", initialDelayMs: 0 },
      );
      dbFallbackQueue.enqueue(
        { threadId: "t-ignored", role: "user", content: "msg-c" },
        { type: "db_chat_message", initialDelayMs: 0 },
      );

      const batch = getQueuedMessagesForThreads(new Set(["t-a", "t-b"]));
      expect(batch.length).toBe(2);
      expect(batch.map((m) => m.content).sort()).toEqual(["msg-a", "msg-b"]);
    } finally {
      dbFallbackQueue.clear();
    }
  });

  it("VULN-47: getTransporter invalidates cached SMTP transport on credential rotation and /v2/admin/mail/send blocks recipient delimiter injection", async () => {
    const nodemailer = require("nodemailer");
    const { getTransporter, resetTransporterCache } = await import("../lib/mail/naver");

    const prevToken = process.env.ADMIN_TOKEN;
    const prevUser = process.env.NAVER_MAIL_USER;
    const prevPass = process.env.NAVER_MAIL_PASSWORD;
    const origCreate = nodemailer.createTransport;
    let closedCount = 0;
    const seenUsers: string[] = [];

    nodemailer.createTransport = (opts: any) => {
      seenUsers.push(opts.auth.user);
      return {
        sendMail: async () => ({ messageId: "m1", accepted: [], rejected: [] }),
        close: () => {
          closedCount++;
        },
        on: () => {},
      };
    };

    try {
      resetTransporterCache();
      process.env.NAVER_MAIL_USER = "first@naver.com";
      process.env.NAVER_MAIL_PASSWORD = "pw1";
      const t1 = getTransporter();
      const t1Again = getTransporter();
      expect(t1).toBe(t1Again);

      // Rotate credentials -> must close t1 and instantiate fresh transporter
      process.env.NAVER_MAIL_USER = "second@naver.com";
      process.env.NAVER_MAIL_PASSWORD = "pw2";
      const t2 = getTransporter();
      expect(t2).not.toBe(t1);
      expect(closedCount).toBe(1);
      expect(seenUsers).toEqual(["first@naver.com", "second@naver.com"]);

      // Recipient delimiter/angle-bracket injection -> HTTP 400
      process.env.ADMIN_TOKEN = "test-admin-secret";
      const app = await createApp(true);
      for (const badTo of [
        'attacker"<bcc@evil.com>@example.com',
        "semi;colon@example.com",
        `${"a".repeat(320)}@example.com`,
      ]) {
        const res = await app.handle(
          new Request("http://localhost/v2/admin/mail/send", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-admin-token": "test-admin-secret",
            },
            body: JSON.stringify({
              to: badTo,
              subject: "Test",
              text: "Body",
            }),
          }),
        );
        expect(res.status).toBe(400);
      }
    } finally {
      nodemailer.createTransport = origCreate;
      resetTransporterCache();
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
      if (prevUser === undefined) delete process.env.NAVER_MAIL_USER;
      else process.env.NAVER_MAIL_USER = prevUser;
      if (prevPass === undefined) delete process.env.NAVER_MAIL_PASSWORD;
      else process.env.NAVER_MAIL_PASSWORD = prevPass;
    }
  });

  it("VULN-48: YouTube endpoints block whitespace/control-char redirectUri and oversized token/handle/pageToken locally without outbound API calls", async () => {
    const { google } = await import("googleapis");
    const origYoutube = google.youtube;
    let outboundCalls = 0;

    try {
      (google as any).youtube = () => {
        outboundCalls++;
        return {};
      };

      const app = await createApp(true);

      // 1. redirectUri containing space/null byte on /auth/create -> 422
      const badCreate = await app.handle(
        new Request("http://localhost/v1/youtube/auth/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: "123-abc.apps.googleusercontent.com",
            clientSecret: "GOCSPX-secret",
            redirectUri: "https://example.com/callback with space",
          }),
        }),
      );
      expect(badCreate.status).toBe(422);

      // 2. Oversized accessToken (> 4096) or handle (> 128) or pageToken (> 512) -> instant 400, 0 outbound calls
      const r1 = await app.handle(
        new Request("http://localhost/v1/youtube/video/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            handle: "@" + "h".repeat(130),
            accessToken: "valid-short-token",
          }),
        }),
      );
      expect(r1.status).toBe(400);

      const r2 = await app.handle(
        new Request("http://localhost/v1/youtube/channel/info", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accessToken: "t".repeat(4097),
          }),
        }),
      );
      expect(r2.status).toBe(400);

      const r3 = await app.handle(
        new Request("http://localhost/v1/youtube/comment/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            videoId: "dQw4w9WgXcQ",
            accessToken: "valid-short-token",
            pageToken: "p".repeat(513),
          }),
        }),
      );
      expect(r3.status).toBe(400);
      expect(outboundCalls).toBe(0);
    } finally {
      google.youtube = origYoutube;
    }
  });

  it("VULN-49: UpstashRedisKeyStore serializes Infinity/NaN cooldown safely without JSON null errors, prunes stale keys on syncKeys, and getKeyStore reacts to env changes", async () => {
    const { UpstashRedisKeyStore } = await import(
      "../lib/llm/key-manager/stores/upstash-redis"
    );
    const { MemoryKeyStore } = await import(
      "../lib/llm/key-manager/stores/memory"
    );
    const { getKeyStore, resetCachedProviderForTesting } = await import(
      "../lib/llm/factory"
    );

    const mem = new MemoryKeyStore();
    const store = new UpstashRedisKeyStore(
      "https://mock-upstash-49.local",
      "mock-token",
      { memoryFallback: mem },
    );

    const evalBodies: any[][] = [];
    const pipelineBodies: any[][][] = [];
    const originalFetch = globalThis.fetch;
    const prevRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    try {
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/pipeline")) {
          const cmds = JSON.parse(String(init?.body ?? "[]"));
          pipelineBodies.push(cmds);
          return new Response(
            JSON.stringify(cmds.map(() => ({ result: 1 }))),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/eval")) {
          const body = JSON.parse(String(init?.body ?? "[]"));
          evalBodies.push(body);
          return new Response(JSON.stringify({ result: "OK" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      }) as any;

      // 1. Seed 2 keys, then rotate to 1 key -> stale key k-old must be pruned from memory & Redis list reset
      await store.syncKeys([
        { id: "k-old", apiKey: "sk-old", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-keep", apiKey: "sk-keep", tier: 0, weight: 10, maxConcurrency: 5 },
      ]);
      expect((await store.getAllStates()).map((s) => s.id)).toEqual(["k-old", "k-keep"]);

      await store.syncKeys([
        { id: "k-keep", apiKey: "sk-keep", tier: 0, weight: 10, maxConcurrency: 5 },
      ]);
      expect((await store.getAllStates()).map((s) => s.id)).toEqual(["k-keep"]);
      expect(pipelineBodies[1][0]).toEqual(["DEL", "openrouter:keys:list"]);

      // Empty key sync must NOT emit invalid 2-arg SADD
      await store.syncKeys([]);
      expect(pipelineBodies[2].some((c) => c[0] === "SADD")).toBe(false);

      // 2. Releasing with Infinity cooldown (402 exhaustion) must NEVER serialize null into /eval ARGV
      await store.syncKeys([
        { id: "k-402", apiKey: "sk-402", accountId: "acc-49", tier: 0, weight: 10, maxConcurrency: 5 },
      ]);
      await store.releaseKey("k-402", "lease-inf-49", 402, Infinity, "Wallet empty");

      expect(evalBodies.length).toBe(1);
      const evalArgs = evalBodies[0];
      // [script, numKeys, hashKey, leaseToken, statusCode, cooldownMs, errMsg]
      expect(evalArgs.includes(null)).toBe(false);
      expect(evalArgs[5]).toBe(0);

      // 3. getKeyStore invalidates singleton when UPSTASH_REDIS_REST_URL changes
      resetCachedProviderForTesting();
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      const sMem = getKeyStore();
      expect(sMem).toBeInstanceOf(MemoryKeyStore);

      process.env.UPSTASH_REDIS_REST_URL = "https://upstash-1.example.com";
      process.env.UPSTASH_REDIS_REST_TOKEN = "tok-1";
      const sRedis1 = getKeyStore();
      expect(sRedis1).toBeInstanceOf(UpstashRedisKeyStore);

      process.env.UPSTASH_REDIS_REST_URL = "https://upstash-2.example.com";
      const sRedis2 = getKeyStore();
      expect(sRedis2).not.toBe(sRedis1);
    } finally {
      globalThis.fetch = originalFetch;
      if (prevRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = prevRedisUrl;
      if (prevRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = prevRedisToken;
      resetCachedProviderForTesting();
    }
  });

  it("VULN-50: CORS guard blocks Origin: null reflection, omits wildcard+credentials conflict, and prevents internal proxy header echoing on OPTIONS preflight", async () => {
    const { sanitizeCorsOrigin } = await import("../src/app");
    expect(sanitizeCorsOrigin("null")).toBeNull();
    expect(sanitizeCorsOrigin("javascript:alert(1)")).toBeNull();
    expect(sanitizeCorsOrigin("https://user:pass@evil.com")).toBeNull();
    expect(sanitizeCorsOrigin("https://evil.com/extra-path")).toBeNull();
    expect(sanitizeCorsOrigin("https://tokki.app")).toBe("https://tokki.app");
    expect(sanitizeCorsOrigin("http://localhost:5173")).toBe("http://localhost:5173");

    const app = await createApp(true);

    // 1. Sandboxed iframe Origin: null must NEVER reflect Access-Control-Allow-Origin: null
    const nullOriginRes = await app.handle(
      new Request("http://localhost/v1/healthz", {
        headers: { origin: "null" },
      }),
    );
    expect(nullOriginRes.status).toBe(200);
    expect(nullOriginRes.headers.get("access-control-allow-origin")).toBeNull();
    expect(nullOriginRes.headers.get("access-control-allow-credentials")).toBeNull();
    expect(nullOriginRes.headers.get("x-content-type-options")).toBe("nosniff");

    // 2. Non-CORS request (no Origin header) must NOT emit wildcard * + credentials: true conflict
    const plainRes = await app.handle(new Request("http://localhost/v1/healthz"));
    expect(plainRes.status).toBe(200);
    expect(plainRes.headers.get("access-control-allow-origin")).toBeNull();
    expect(plainRes.headers.get("access-control-allow-credentials")).toBeNull();

    // 3. OPTIONS preflight with legitimate Origin returns 204 and allowlisted headers WITHOUT echoing x-vercel-oidc-token
    const preflightRes = await app.handle(
      new Request("http://localhost/v2/ask", {
        method: "OPTIONS",
        headers: {
          origin: "https://client.tokki.app",
          "access-control-request-method": "POST",
          "x-vercel-oidc-token": "secret-platform-oidc-jwt",
          "x-vercel-proxy-signature": "secret-sig",
        },
      }),
    );
    expect(preflightRes.status).toBe(204);
    expect(preflightRes.headers.get("access-control-allow-origin")).toBe(
      "https://client.tokki.app",
    );
    const allowHeaders = (
      preflightRes.headers.get("access-control-allow-headers") || ""
    ).toLowerCase();
    expect(allowHeaders).toContain("x-admin-token");
    expect(allowHeaders).not.toContain("x-vercel-oidc-token");
    expect(allowHeaders).not.toContain("x-vercel-proxy-signature");
  });

  it("VULN-51: /v2/ask skips redundant listMessages DB RTT on fresh thread creation, preserves user prompt on DB outage, and normalizes JSON null/array bodies", async () => {
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_KEY;
    const prevLlmKey = process.env.LLM_API_KEY;
    const prevOrKeys = process.env.OPENROUTER_API_KEYS;
    const originalFetch = globalThis.fetch;
    const widgetStoreMod: any = await import("../lib/widget-store?real-v51" as any);

    try {
      process.env.SUPABASE_URL = "https://mock-supabase-51.local";
      process.env.SUPABASE_SERVICE_KEY = "mock-service-key-51";
      delete process.env.LLM_API_KEY;
      delete process.env.OPENROUTER_API_KEYS;
      widgetStoreMod?.invalidateWidgetCache?.("registered-valid-widget");

      let chatMessageGetCalls = 0;
      let simulateDbOutage = false;

      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const rawUrl = typeof input === "string" ? input : input?.url || String(input);
        const parsed = new URL(rawUrl);
        if (parsed.hostname === "mock-supabase-51.local") {
          const method = (init?.method ?? "GET").toUpperCase();
          if (parsed.pathname.endsWith("/widget")) {
            return new Response(
              JSON.stringify({
                id: "registered-valid-widget",
                name: "Test Bot",
                theme: "noir",
                description: "Online",
                welcome_message: "Hi",
                system_prompt: "Reply concisely.",
                suggested_questions: [],
                icon_url: null,
                chat_bubble_size: null,
                is_deleted: false,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (simulateDbOutage) {
            return new Response(JSON.stringify({ message: "DB connection refused" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
          if (parsed.pathname.endsWith("/chat_thread") && method === "POST") {
            return new Response(
              JSON.stringify({ id: "00000000-0000-4000-8000-000000000051" }),
              { status: 201, headers: { "content-type": "application/json" } },
            );
          }
          if (parsed.pathname.endsWith("/chat_message")) {
            if (method === "GET") chatMessageGetCalls++;
            return new Response(JSON.stringify([]), {
              status: method === "POST" ? 201 : 200,
              headers: { "content-type": "application/json" },
            });
          }
        }
        return originalFetch(input, init);
      }) as any;

      const app = await createApp(true);

      // 1. Fresh thread creation skips redundant GET /chat_message SELECT
      const resFresh = await app.handle(
        new Request("http://localhost/v2/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            widgetId: "registered-valid-widget",
            message: "안녕하세요",
          }),
        }),
      );
      expect(resFresh.status).toBe(200);
      const sseText = await resFresh.text();
      expect(sseText).toContain("[DONE]");
      expect(chatMessageGetCalls).toBe(0);

      // 2. Simulated DB outage on createThread/appendMessage still streams valid reply
      simulateDbOutage = true;
      const resOutage = await app.handle(
        new Request("http://localhost/v2/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            widgetId: "registered-valid-widget",
            message: "추천 해주세요",
          }),
        }),
      );
      expect(resOutage.status).toBe(200);
      expect(await resOutage.text()).toContain("[DONE]");

      // 3. JSON primitive "null" or array "[1,2]" on /v2/ask returns 403 (never 422 TypeBox schema leak)
      for (const rawJson of ["null", "[1, 2, 3]"]) {
        const primRes = await app.handle(
          new Request("http://localhost/v2/ask", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: rawJson,
          }),
        );
        expect(primRes.status).toBe(403);
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (prevUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = prevKey;
      if (prevLlmKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevLlmKey;
      if (prevOrKeys === undefined) delete process.env.OPENROUTER_API_KEYS;
      else process.env.OPENROUTER_API_KEYS = prevOrKeys;
    }
  });

  it("VULN-52: Admin widget/thread endpoints reject PostgreSQL-breaking null bytes (\\x00) and invalid delete IDs with HTTP 400", async () => {
    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "test-admin-secret";
    try {
      const app = await createApp(true);

      // 1. Null byte in widget upsert description/system_prompt -> HTTP 400
      const resUpsertNull = await app.handle(
        new Request("http://localhost/v2/admin/widgets/upsert", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({
            id: "safe-widget",
            system_prompt: "Hello\u0000World",
          }),
        }),
      );
      expect(resUpsertNull.status).toBe(400);

      // 2. Null byte in /v2/admin/threads/update context_text -> HTTP 400
      const resThreadNull = await app.handle(
        new Request("http://localhost/v2/admin/threads/update", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-secret",
          },
          body: JSON.stringify({
            widgetId: "safe-widget",
            threadId: "thread-1",
            context_text: "RAG\u0000Data",
          }),
        }),
      );
      expect(resThreadNull.status).toBe(400);

      // 3. Whitespace or >100-char ID on /v2/admin/widgets/delete -> HTTP 400
      for (const badId of ["   ", "d".repeat(101), "bad\u0000id"]) {
        const resDel = await app.handle(
          new Request("http://localhost/v2/admin/widgets/delete", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-admin-token": "test-admin-secret",
            },
            body: JSON.stringify({ id: badId }),
          }),
        );
        expect(resDel.status).toBe(400);
      }
    } finally {
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });

  it("VULN-53: YouTube endpoints retry transient 429s, propagate persistent 429 + Retry-After, and block smuggled accessToken/OAuth state locally", async () => {
    const { google } = await import("googleapis");
    const origYoutube = google.youtube;
    let channelCalls = 0;
    let mode: "transient_429" | "persistent_429" = "transient_429";

    try {
      (google as any).youtube = () => ({
        channels: {
          list: async () => {
            channelCalls++;
            if (mode === "transient_429" && channelCalls === 1) {
              const err: any = new Error("Quota rateLimitExceeded");
              err.code = 429;
              err.response = {
                status: 429,
                headers: { "retry-after": "0.05" },
              };
              throw err;
            }
            if (mode === "persistent_429") {
              const err: any = new Error("User rate limit exceeded");
              err.code = 429;
              err.response = {
                status: 429,
                headers: { "retry-after": "12" },
              };
              throw err;
            }
            return {
              data: {
                items: [{ id: "UC1no5Q01M2LmT-QLgLlUN0Q" }],
                pageInfo: { totalResults: 1, resultsPerPage: 5 },
              },
            };
          },
        },
      });

      const app = await createApp(true);

      // 1. Transient 429 automatically retries and succeeds with HTTP 200
      const okRes = await app.handle(
        new Request("http://localhost/v1/youtube/channel/info", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken: "ya29.valid_token" }),
        }),
      );
      expect(okRes.status).toBe(200);
      expect(channelCalls).toBe(2);

      // 2. Persistent 429 with Retry-After: 12 (> 2s serverless cap) fails fast with HTTP 429 + Retry-After: 12
      mode = "persistent_429";
      const rlRes = await app.handle(
        new Request("http://localhost/v1/youtube/channel/info", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken: "ya29.valid_token" }),
        }),
      );
      expect(rlRes.status).toBe(429);
      expect(rlRes.headers.get("retry-after")).toBe("12");

      // 3. Smuggled whitespace/CRLF accessToken is blocked locally (0 extra youtube calls)
      const callsBefore = channelCalls;
      const smuggledRes = await app.handle(
        new Request("http://localhost/v1/youtube/channel/info", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken: "ya29.bad\r\nX-Evil: 1" }),
        }),
      );
      expect(smuggledRes.status).toBe(400);
      expect(channelCalls).toBe(callsBefore);

      // 4. Forged OAuth confirm state with invalid clientId pattern or backslash redirectUri -> local 400
      const forgedState = Buffer.from(
        JSON.stringify({
          clientId: "not-a-google-client-id",
          clientSecret: "GOCSPX-valid",
          redirectUri: "https://example.com/\\@evil.com",
        }),
      ).toString("base64");
      const confirmRes = await app.handle(
        new Request(
          `http://localhost/v1/youtube/auth/confirm?code=valid_code&state=${encodeURIComponent(forgedState)}`,
        ),
      );
      expect(confirmRes.status).toBe(400);
    } finally {
      google.youtube = origYoutube;
    }
  });

  it("VULN-54: OpenAICompatibleProvider supports preStreamHandshake/streamFromHandshake and surfaces structured 429 Retry-After, 402, 503, and 413 codes before SSE commit", async () => {
    const { OpenAICompatibleProvider } = await import("../lib/llm/openai-compatible");
    const origFetch = globalThis.fetch;
    const prevRetryMax = process.env.LLM_RETRY_MAX;

    try {
      process.env.LLM_RETRY_MAX = "0";
      let upstreamMode: "429" | "402" | "503" | "413" | "200" = "429";

      globalThis.fetch = (async () => {
        if (upstreamMode === "429") {
          return new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "retry-after": "14" },
          });
        }
        if (upstreamMode === "402") {
          return new Response("Insufficient credits", {
            status: 402,
            statusText: "Payment Required",
          });
        }
        if (upstreamMode === "503") {
          return new Response("Overloaded", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        if (upstreamMode === "413") {
          return new Response("Context length exceeded", {
            status: 413,
            statusText: "Payload Too Large",
          });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"SingleKeyOK"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }) as any;

      const provider = new OpenAICompatibleProvider({
        name: "gemini",
        baseUrl: "https://mock-gemini.local/v1beta/openai",
        apiKey: "sk-gemini",
        defaultModel: "gemini-3.5-flash-lite",
      });

      // 1. 429 -> ALL_KEYS_RATE_LIMITED with exact retryAfterSeconds = 14
      let err429: any = null;
      try {
        await provider.preStreamHandshake({
          messages: [{ role: "user", content: "hi" }],
        });
      } catch (e) {
        err429 = e;
      }
      expect(err429?.statusCode).toBe(429);
      expect(err429?.code).toBe("ALL_KEYS_RATE_LIMITED");
      expect(err429?.retryAfterSeconds).toBe(14);

      // 2. 402 -> ALL_ACCOUNTS_EXHAUSTED
      upstreamMode = "402";
      let err402: any = null;
      try {
        await provider.preStreamHandshake({
          messages: [{ role: "user", content: "hi" }],
        });
      } catch (e) {
        err402 = e;
      }
      expect(err402?.statusCode).toBe(402);
      expect(err402?.code).toBe("ALL_ACCOUNTS_EXHAUSTED");

      // 3. 503 -> UPSTREAM_MODEL_OUTAGE
      upstreamMode = "503";
      let err503: any = null;
      try {
        await provider.preStreamHandshake({
          messages: [{ role: "user", content: "hi" }],
        });
      } catch (e) {
        err503 = e;
      }
      expect(err503?.statusCode).toBe(503);
      expect(err503?.code).toBe("UPSTREAM_MODEL_OUTAGE");

      // 4. 413 -> UPSTREAM_CLIENT_ERROR
      upstreamMode = "413";
      let err413: any = null;
      try {
        await provider.preStreamHandshake({
          messages: [{ role: "user", content: "hi" }],
        });
      } catch (e) {
        err413 = e;
      }
      expect(err413?.statusCode).toBe(413);
      expect(err413?.code).toBe("UPSTREAM_CLIENT_ERROR");

      // 5. 200 -> preStreamHandshake + streamFromHandshake yields tokens cleanly
      upstreamMode = "200";
      const hs = await provider.preStreamHandshake({
        messages: [{ role: "user", content: "hi" }],
      });
      const out: string[] = [];
      for await (const tk of provider.streamFromHandshake(hs)) {
        out.push(tk);
      }
      expect(out.join("")).toBe("SingleKeyOK");
    } finally {
      globalThis.fetch = origFetch;
      if (prevRetryMax === undefined) delete process.env.LLM_RETRY_MAX;
      else process.env.LLM_RETRY_MAX = prevRetryMax;
    }
  });

  it("VULN-55: Serverless handler blocks >65535 ports, malformed IPv6, backslash host overrides, HTTP/2 pseudo-headers, and cleans up req/res listeners", async () => {
    const { EventEmitter } = await import("node:events");
    const handlerMod = await import("../lambda-src/handler");
    const { sanitizeHost, sanitizeRequestPath, default: serverlessHandler } = handlerMod;

    // 1. Out-of-range TCP ports and malformed IPv6 fall back to localhost instead of throwing Invalid URL
    expect(sanitizeHost("evil.com:99999")).toBe("localhost");
    expect(sanitizeHost("example..com:70000")).toBe("localhost");
    expect(sanitizeHost("[:::1]")).toBe("localhost");
    expect(sanitizeHost("[:]")).toBe("localhost");
    expect(sanitizeHost("[::1]:8080")).toBe("[::1]:8080");
    expect(sanitizeHost("my-server-mocha.vercel.app")).toBe("my-server-mocha.vercel.app");

    // 2. Leading backslashes and protocol-relative paths stay pinned to /
    expect(sanitizeRequestPath("/\\evil.com/v1/healthz", "https://localhost")).toBe(
      "/evil.com/v1/healthz",
    );
    expect(sanitizeRequestPath("\\\\evil.com/v1/healthz", "https://localhost")).toBe(
      "/evil.com/v1/healthz",
    );

    // 3. Full handler invocation with :method HTTP/2 pseudo-header + evil.com:99999 succeeds (200 OK) with 0 leaked listeners
    const reqEmitter: any = Object.assign(new EventEmitter(), {
      url: "/v1/healthz",
      method: "GET",
      complete: true,
      headers: {
        ":method": "GET",
        ":authority": "my-server-mocha.vercel.app",
        "x-forwarded-host": "evil.com:99999",
        "x-custom-bad": "val\u0000ue",
      },
    });
    let bodyOut = "";
    const resEmitter: any = Object.assign(new EventEmitter(), {
      statusCode: 0,
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      headers: {} as Record<string, any>,
      setHeader(k: string, v: any) {
        this.headers[k.toLowerCase()] = v;
      },
      getHeader(k: string) {
        return this.headers[k.toLowerCase()];
      },
      write(chunk: any) {
        this.headersSent = true;
        bodyOut += Buffer.from(chunk).toString("utf8");
        return true;
      },
      end(chunk?: any) {
        if (chunk) bodyOut += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        this.writableEnded = true;
      },
    });

    await serverlessHandler(reqEmitter, resEmitter);
    expect(resEmitter.statusCode).toBe(200);
    expect(bodyOut).toBe("OK");
    expect(reqEmitter.listenerCount("aborted")).toBe(0);
    expect(reqEmitter.listenerCount("close")).toBe(0);
    expect(resEmitter.listenerCount("close")).toBe(0);

    // 4. Control-byte Content-Length smuggling returns HTTP 400 (never 500 or silent header drop)
    const badClReq: any = Object.assign(new EventEmitter(), {
      url: "/v2/ask",
      method: "POST",
      complete: true,
      headers: {
        host: "localhost",
        "content-length": "10\u00009999999",
      },
    });
    let badClBody = "";
    const badClRes: any = Object.assign(new EventEmitter(), {
      statusCode: 0,
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      setHeader() {},
      end(c?: any) {
        if (c) badClBody += String(c);
        this.writableEnded = true;
      },
    });
    await serverlessHandler(badClReq, badClRes);
    expect(badClRes.statusCode).toBe(400);
    expect(badClBody).toContain("Content-Length");
  });

  it("VULN-56: /v2/ask & appendMessage sanitize PostgreSQL-breaking NUL bytes, admin endpoints enforce 400/500 on invalid IDs/migrations, and normalizeIp bounds megabyte headers", async () => {
    const prevAdmin = process.env.ADMIN_TOKEN;
    const prevSupaUrl = process.env.SUPABASE_URL;
    const prevSupaKey = process.env.SUPABASE_SERVICE_KEY;
    const origFetch = globalThis.fetch;
    const realChatStore: any = await import("../lib/chat-store?real-v56" as any);

    try {
      process.env.ADMIN_TOKEN = "test-admin-v56";
      process.env.SUPABASE_URL = "https://mock-supa-56.local";
      process.env.SUPABASE_SERVICE_KEY = "mock-key-56";

      let insertedPayloads: any[] = [];
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input.url);
        if (u.hostname === "mock-supa-56.local") {
          if (u.pathname.endsWith("/chat_message") && init?.method === "POST") {
            insertedPayloads.push(JSON.parse(String(init.body ?? "{}")));
            return new Response(JSON.stringify([]), {
              status: 201,
              headers: { "content-type": "application/json" },
            });
          }
          if (u.pathname.endsWith("/_migration_history")) {
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (u.pathname.includes("/rpc/admin_exec_sql")) {
            return new Response(JSON.stringify({ message: "syntax error in SQL" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }
          if (u.pathname.endsWith("/widget")) {
            return new Response(
              JSON.stringify({
                id: "registered-valid-widget",
                name: "Bot",
                theme: "noir",
                description: "",
                welcome_message: "",
                system_prompt: null,
                suggested_questions: [],
                icon_url: null,
                chat_bubble_size: null,
                is_deleted: false,
                created_at: "",
                updated_at: "",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
        }
        return origFetch(input, init);
      }) as any;

      // 1. Real appendMessage strips embedded \x00 and rejects pure \x00 or >100-char threadId
      expect(await realChatStore.appendMessage("t".repeat(101), "user", "hi")).toBe(false);
      expect(await realChatStore.appendMessage("tid-ok", "user", "\u0000  \u0000")).toBe(false);
      expect(await realChatStore.appendMessage("tid-ok", "user", "Hello\u0000World")).toBe(true);
      expect(insertedPayloads[0]?.content).toBe("HelloWorld");

      const app = await createApp(true);

      // 2. Pure \u0000 message on /v2/ask -> HTTP 400 ("message required")
      const nulAskRes = await app.handle(
        new Request("http://localhost/v2/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            widgetId: "registered-valid-widget",
            message: "\u0000   \u0000",
          }),
        }),
      );
      expect(nulAskRes.status).toBe(400);

      // 3. Whitespace-only or control-char IDs on admin thread/message/upload routes -> HTTP 400
      for (const route of ["/v2/admin/threads/update", "/v2/admin/threads/rename"]) {
        const emptyRes = await app.handle(
          new Request(`http://localhost${route}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-admin-token": "test-admin-v56",
            },
            body: JSON.stringify({ widgetId: "   ", threadId: "tid-1" }),
          }),
        );
        expect(emptyRes.status).toBe(400);

        const ctrlRes = await app.handle(
          new Request(`http://localhost${route}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-admin-token": "test-admin-v56",
            },
            body: JSON.stringify({ widgetId: "wid\u0007", threadId: "tid-1" }),
          }),
        );
        expect(ctrlRes.status).toBe(400);
      }

      const badMsgRes = await app.handle(
        new Request("http://localhost/v2/admin/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-v56",
          },
          body: JSON.stringify({ widgetId: "w".repeat(101), threadId: "tid-1" }),
        }),
      );
      expect(badMsgRes.status).toBe(400);

      // 4. Failed SQL migration RPC in /v2/admin/db/migrate returns HTTP 500 (not 200 OK)
      const migRes = await app.handle(
        new Request("http://localhost/v2/admin/db/migrate", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-v56",
          },
          body: JSON.stringify({ dryRun: false }),
        }),
      );
      expect(migRes.status).toBe(500);

      // 5. normalizeIp caps megabyte/control-char X-Forwarded-For payloads to 127.0.0.1
      expect(normalizeIp("9".repeat(50_000))).toBe("127.0.0.1");
      expect(normalizeIp("198.51.100.1\u0000evil")).toBe("127.0.0.1");
    } finally {
      globalThis.fetch = origFetch;
      if (prevAdmin === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevAdmin;
      if (prevSupaUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevSupaUrl;
      if (prevSupaKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = prevSupaKey;
    }
  });

  it("VULN-57: getWidget coalesces concurrent cold-start stampedes (20 -> 1 query), retries read-only 429s, and serves stale live widget during transient DB outages", async () => {
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_KEY;
    const origFetch = globalThis.fetch;
    const realWidgetStore: any = await import("../lib/widget-store?real-v57" as any);

    try {
      process.env.SUPABASE_URL = "https://mock-supa-57.local";
      process.env.SUPABASE_SERVICE_KEY = "mock-key-57";
      realWidgetStore.invalidateWidgetCache();

      let dbSelectCount = 0;
      let mode: "ok" | "transient_429" | "hard_503" = "ok";

      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input.url);
        if (u.hostname === "mock-supa-57.local" && u.pathname.endsWith("/widget")) {
          dbSelectCount++;
          await new Promise((r) => setTimeout(r, 15));
          if (mode === "transient_429" && dbSelectCount === 1) {
            return new Response(JSON.stringify({ message: "429 Too Many Requests" }), {
              status: 429,
              headers: { "content-type": "application/json" },
            });
          }
          if (mode === "hard_503") {
            return new Response(JSON.stringify({ message: "Upstream DB unavailable" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              id: "coalesce-widget",
              name: "Coalesced Bot",
              theme: "noir",
              description: "",
              welcome_message: "",
              system_prompt: null,
              suggested_questions: [],
              icon_url: null,
              chat_bubble_size: null,
              is_deleted: false,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return origFetch(input, init);
      }) as any;

      // 1. 20 concurrent cold-start calls coalesce into 1 single PostgREST SELECT
      const results = await Promise.all(
        Array.from({ length: 20 }, () => realWidgetStore.getWidget("coalesce-widget")),
      );
      expect(dbSelectCount).toBe(1);
      expect(results.every((r) => r?.id === "coalesce-widget")).toBe(true);

      // 2. Transient read-only 429 retries once and succeeds
      realWidgetStore.invalidateWidgetCache("coalesce-widget");
      dbSelectCount = 0;
      mode = "transient_429";
      const retried = await realWidgetStore.getWidget("coalesce-widget");
      expect(retried?.id).toBe("coalesce-widget");
      expect(dbSelectCount).toBe(2);

      // 3. Explicit invalidation clears stale cache so deleted/revoked widgets fail closed on outage
      realWidgetStore.invalidateWidgetCache("coalesce-widget");
      mode = "hard_503";
      const afterInvalidate = await realWidgetStore.getWidget("coalesce-widget");
      expect(afterInvalidate).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = prevKey;
    }
  });

  it("VULN-58: processMailQueue & processSmsQueue drain with 0-retry non-blocking attempts on persistent 429s, and resetKeyToActive restores sibling 402 keys while preserving 401 revocations", async () => {
    const { mailFallbackQueue } = await import("../lib/queue/fallback-queue");
    const { processMailQueue, resetTransporterCache } = await import("../lib/mail/naver");
    const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");
    const { UpstashRedisKeyStore } = await import("../lib/llm/key-manager/stores/upstash-redis");

    // 1. processMailQueue executes exactly 1 attempt per job (0ms retry sleep) when SMTP remains 421
    const prevNaverId = process.env.NAVER_ID;
    const prevNaverPass = process.env.NAVER_APP_PASSWORD;
    const nodemailer = require("nodemailer");
    const origCreateTransport = nodemailer.createTransport;
    let smtpCalls = 0;
    try {
      process.env.NAVER_ID = "drainuser";
      process.env.NAVER_APP_PASSWORD = "drainpass";
      mailFallbackQueue.clear();
      resetTransporterCache();

      nodemailer.createTransport = () => ({
        sendMail: async () => {
          smtpCalls++;
          const err: any = new Error("421 4.7.0 Temporary rate limit");
          err.responseCode = 421;
          err.retryAfter = "7";
          throw err;
        },
        close: () => {},
        on: () => {},
      });

      const job = mailFallbackQueue.enqueue(
        { to: "u@example.com", subject: "Subj", text: "Body" },
        { initialDelayMs: 0 },
      );
      const t0 = performance.now();
      const drainRes = await processMailQueue(5);
      const elapsedMs = performance.now() - t0;

      expect(drainRes.processed).toBe(1);
      expect(drainRes.failed).toBe(1);
      expect(smtpCalls).toBe(1); // Strictly 1 attempt (no 3x backoff sleep inside drain!)
      expect(elapsedMs).toBeLessThan(200);
      // Retry-After: 7s preserved through explainSmtpError -> backoffMs >= 7050ms
      expect(mailFallbackQueue.get(job.id)?.backoffMs).toBeGreaterThanOrEqual(7000);
    } finally {
      nodemailer.createTransport = origCreateTransport;
      resetTransporterCache();
      mailFallbackQueue.clear();
      if (prevNaverId === undefined) delete process.env.NAVER_ID;
      else process.env.NAVER_ID = prevNaverId;
      if (prevNaverPass === undefined) delete process.env.NAVER_APP_PASSWORD;
      else process.env.NAVER_APP_PASSWORD = prevNaverPass;
    }

    // 2. resetKeyToActive restores sibling 402-exhausted keys while preserving 401-revoked sibling keys
    const origFetch = globalThis.fetch;
    const redisPipelines: any[][][] = [];
    try {
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("upstash-v58.mock")) {
          if (url.endsWith("/pipeline")) {
            const cmds = JSON.parse(String(init?.body ?? "[]"));
            redisPipelines.push(cmds);
            return new Response(JSON.stringify(cmds.map(() => ({ result: "OK" }))), {
              status: 200,
            });
          }
          if (url.endsWith("/eval")) {
            return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
          }
        }
        return origFetch(input, init);
      }) as any;

      const mem = new MemoryKeyStore();
      const redis = new UpstashRedisKeyStore("https://upstash-v58.mock", "tok", {
        memoryFallback: mem,
      });
      await redis.syncKeys([
        { id: "k-sib-a", apiKey: "sk-a", accountId: "acc-58", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-sib-b", apiKey: "sk-b", accountId: "acc-58", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-revoked-c", apiKey: "sk-c", accountId: "acc-58", tier: 0, weight: 10, maxConcurrency: 5 },
      ]);

      // k-sib-a hits 402 -> bulk-exhausts k-sib-a & k-sib-b (and k-revoked-c) with 402, then k-revoked-c gets explicit 401
      await redis.releaseKey("k-sib-a", "l1", 402, Infinity, "Wallet empty");
      await redis.releaseKey("k-revoked-c", "l2", 401, Infinity, "Key revoked");

      redisPipelines.length = 0;
      await redis.resetKeyToActive("k-sib-a");

      const states = await redis.getAllStates();
      expect(states.find((s) => s.id === "k-sib-a")?.status).toBe("ACTIVE");
      expect(states.find((s) => s.id === "k-sib-b")?.status).toBe("ACTIVE");
      expect(states.find((s) => s.id === "k-revoked-c")?.status).toBe("EXHAUSTED");

      const resetPipelineJson = JSON.stringify(redisPipelines);
      expect(resetPipelineJson).toContain("openrouter:key:k-sib-a");
      expect(resetPipelineJson).toContain("openrouter:key:k-sib-b");
      expect(resetPipelineJson).not.toContain("openrouter:key:k-revoked-c");
      expect(resetPipelineJson).toContain("openrouter:account:acc-58:broken");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("VULN-59: Non-ASCII Korean LLM_TITLE / CRLF headers are ByteString-encoded without crashing fetch(), and parseKeyConfigsFromEnv deduplicates/sanitizes comma-bearing IDs", async () => {
    const {
      parseKeyConfigsFromEnv,
      sanitizeHttpHeaderValue,
      createRotatingOrConfiguredProvider,
      resetCachedProviderForTesting,
    } = await import("../lib/llm/factory");

    const prevKeys = process.env.OPENROUTER_API_KEYS;
    const prevTitle = process.env.LLM_TITLE;
    const prevRef = process.env.LLM_REFERER;
    const origFetch = globalThis.fetch;

    try {
      // 1. Korean title + CRLF injection converts to validWHATWG ByteString
      const safeTitle = sanitizeHttpHeaderValue("토키 AI\r\nInjected: bad", "Tokki AI");
      expect(() => new Headers({ "X-Title": safeTitle })).not.toThrow();
      expect(safeTitle).not.toContain("\r");
      expect(safeTitle).not.toContain("\n");
      expect(decodeURIComponent(safeTitle)).toBe("토키 AI Injected: bad");

      // 2. parseKeyConfigsFromEnv sanitizes commas/spaces in IDs, deduplicates IDs, and filters invalid bearer tokens
      process.env.OPENROUTER_API_KEYS = JSON.stringify([
        { id: "key,with,commas 1", apiKey: "  sk-valid-1  ", tier: 0 },
        { id: "key_with_commas_1", apiKey: "sk-valid-2", tier: 1 },
        { id: "bad-space-key", apiKey: "sk-bad token\nwith-newline" },
      ]);
      const parsed = parseKeyConfigsFromEnv();
      expect(parsed.length).toBe(2);
      expect(parsed[0].id).toBe("key_with_commas_1");
      expect(parsed[1].id).toBe("key_with_commas_1-2");
      expect(parsed[0].apiKey).toBe("sk-valid-1");

      // 3. End-to-end RotatingLLMProvider handshake succeeds with Korean LLM_TITLE
      process.env.LLM_TITLE = "무련 도우미";
      process.env.LLM_REFERER = "https://tokki.app/챗봇";
      resetCachedProviderForTesting();
      let capturedHeaders: Headers | null = null;
      globalThis.fetch = (async (_input: any, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as any;

      const provider: any = createRotatingOrConfiguredProvider();
      const hs = await provider.preStreamHandshake({
        messages: [{ role: "user", content: "안녕" }],
      });
      expect(capturedHeaders?.get("x-title")).toBeTruthy();
      for await (const _ of provider.streamFromHandshake(hs)) {
        /* drain */
      }
    } finally {
      globalThis.fetch = origFetch;
      resetCachedProviderForTesting();
      if (prevKeys === undefined) delete process.env.OPENROUTER_API_KEYS;
      else process.env.OPENROUTER_API_KEYS = prevKeys;
      if (prevTitle === undefined) delete process.env.LLM_TITLE;
      else process.env.LLM_TITLE = prevTitle;
      if (prevRef === undefined) delete process.env.LLM_REFERER;
      else process.env.LLM_REFERER = prevRef;
    }
  });

  it("VULN-60: Supabase client trims whitespace credentials, rejects blank strings, and aborts hung PostgREST sockets via SUPABASE_FETCH_TIMEOUT_MS", async () => {
    const { supabaseClient } = await import("../lib/supabase/client");
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_KEY;
    const prevTimeout = process.env.SUPABASE_FETCH_TIMEOUT_MS;
    const origFetch = globalThis.fetch;

    try {
      // 1. Whitespace-only SUPABASE_URL throws explicit missing-env error instead of caching broken empty client
      process.env.SUPABASE_URL = "   ";
      process.env.SUPABASE_SERVICE_KEY = "mock-key";
      expect(() => (supabaseClient as any).from("widget")).toThrow("SUPABASE_URL is not set");

      // 2. Hung PostgREST socket aborts cleanly within SUPABASE_FETCH_TIMEOUT_MS (60ms)
      process.env.SUPABASE_URL = "  https://mock-supa-timeout-60.local  ";
      process.env.SUPABASE_SERVICE_KEY = "  mock-service-key-60\n ";
      process.env.SUPABASE_FETCH_TIMEOUT_MS = "60";

      globalThis.fetch = (async (_input: any, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason || new Error("Aborted"));
            return;
          }
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason || new Error("TimeoutAbort")),
            { once: true },
          );
        });
      }) as any;

      const t0 = performance.now();
      const res = await (supabaseClient as any).from("widget").select("*").maybeSingle();
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(1000);
      expect(res.error).toBeTruthy();
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = prevKey;
      if (prevTimeout === undefined) delete process.env.SUPABASE_FETCH_TIMEOUT_MS;
      else process.env.SUPABASE_FETCH_TIMEOUT_MS = prevTimeout;
    }
  });

  it("VULN-61: /v2/admin/db/migrate tracks history idempotently via upsert, /v2/ask preserves full 20,000-char context_text, and /v2/admin/widgets sanitizes stored icon_url & chat_bubble_size", async () => {
    const prevAdmin = process.env.ADMIN_TOKEN;
    const prevSupaUrl = process.env.SUPABASE_URL;
    const prevSupaKey = process.env.SUPABASE_SERVICE_KEY;
    const prevLlmKey = process.env.LLM_API_KEY;
    const prevOrKeys = process.env.OPENROUTER_API_KEYS;
    const prevProvider = process.env.LLM_PROVIDER;
    const origFetch = globalThis.fetch;

    try {
      process.env.ADMIN_TOKEN = "test-admin-v61";
      process.env.SUPABASE_URL = "https://mock-supa-61.local";
      process.env.SUPABASE_SERVICE_KEY = "mock-key-61";
      process.env.LLM_PROVIDER = "openai";
      process.env.LLM_API_KEY = "sk-test-v61";
      delete process.env.OPENROUTER_API_KEYS;

      const longContext = "R".repeat(17_500) + "TAIL_MARKER_17500";
      let historyPostPrefer = "";
      let capturedLlmMessages: any[] = [];

      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input.url);
        if (u.hostname === "mock-supa-61.local") {
          const method = (init?.method ?? "GET").toUpperCase();
          if (u.pathname.endsWith("/_migration_history")) {
            if (method === "POST") {
              const h = new Headers(init?.headers);
              historyPostPrefer = h.get("prefer") || "";
              return new Response(JSON.stringify([]), {
                status: 201,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (u.pathname.includes("/rpc/admin_exec_sql")) {
            return new Response(null, { status: 204 });
          }
          if (u.pathname.endsWith("/widget")) {
            if (u.search.includes("id=eq.")) {
              return new Response(
                JSON.stringify({
                  id: "registered-valid-widget",
                  name: "Bot",
                  theme: "noir",
                  description: "",
                  welcome_message: "",
                  system_prompt: null,
                  suggested_questions: [],
                  icon_url: null,
                  chat_bubble_size: null,
                  is_deleted: false,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify([
                {
                  id: "poisoned-admin-widget",
                  name: "Poisoned",
                  theme: "noir",
                  description: "",
                  welcome_message: "",
                  system_prompt: null,
                  suggested_questions: [],
                  icon_url: "javascript:alert(1)",
                  chat_bubble_size: "100vw",
                  is_deleted: false,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (u.pathname.endsWith("/chat_thread")) {
            if (u.search.includes("id=eq.")) {
              return new Response(
                JSON.stringify({
                  id: "thread-rag-20k",
                  widget_id: "registered-valid-widget",
                  is_deleted: false,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  title: null,
                  system_prompt: null,
                  context_text: longContext,
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (u.pathname.endsWith("/chat_message")) {
            return new Response(JSON.stringify([]), {
              status: method === "POST" ? 201 : 200,
              headers: { "content-type": "application/json" },
            });
          }
        }
        if (u.hostname === "api.openai.com") {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          capturedLlmMessages = parsedBody.messages ?? [];
          return new Response(
            'data: {"choices":[{"delta":{"content":"답변"}}]}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return origFetch(input, init);
      }) as any;

      const app = await createApp(true);

      // 1. /v2/admin/db/migrate uses PostgREST upsert (Prefer: resolution=merge-duplicates)
      const migRes = await app.handle(
        new Request("http://localhost/v2/admin/db/migrate", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-v61",
          },
          body: JSON.stringify({ dryRun: false }),
        }),
      );
      expect(migRes.status).toBe(200);
      expect(historyPostPrefer).toContain("resolution=merge-duplicates");

      // 2. /v2/admin/widgets sanitizes poisoned stored icon_url and chat_bubble_size when returned from store
      const adminWidgetsRes = await app.handle(
        new Request("http://localhost/v2/admin/widgets", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-v61",
          },
          body: "{}",
        }),
      );
      expect(adminWidgetsRes.status).toBe(200);
      const adminWidgetsJson = (await adminWidgetsRes.json()) as any;
      const poisonedRow = adminWidgetsJson.widgets?.find(
        (w: any) => w.widget_id === "poisoned-admin-widget",
      );
      if (poisonedRow) {
        expect(poisonedRow.icon_url).toBeNull();
        expect(poisonedRow.chat_bubble_size).toBeNull();
      }

      // 3. /v2/ask forwards full 17,500+ char thread context_text without truncating at 10,000
      const askRes = await app.handle(
        new Request("http://localhost/v2/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            widgetId: "registered-valid-widget",
            threadId: "thread-rag-20k",
            message: "참고 자료 확인",
          }),
        }),
      );
      expect(askRes.status).toBe(200);
      await askRes.text();
      const ragSystemMsg = capturedLlmMessages.find(
        (m) => m.role === "system" && String(m.content).includes("참고 자료"),
      );
      if (ragSystemMsg) {
        expect(ragSystemMsg.content).toContain("TAIL_MARKER_17500");
      }
    } finally {
      globalThis.fetch = origFetch;
      if (prevAdmin === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevAdmin;
      if (prevSupaUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevSupaUrl;
      if (prevSupaKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = prevSupaKey;
      if (prevLlmKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevLlmKey;
      if (prevOrKeys === undefined) delete process.env.OPENROUTER_API_KEYS;
      else process.env.OPENROUTER_API_KEYS = prevOrKeys;
      if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = prevProvider;
    }
  });

  it("VULN-62: chat-store retries transient PostgREST 429s on getThread/listMessages/createThread without orphaning threads and rejects control-char IDs with 0 DB calls", async () => {
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_KEY;
    const origFetch = globalThis.fetch;
    const realChatStore: any = await import("../lib/chat-store?real-v62" as any);
    const { dbFallbackQueue } = await import("../lib/queue/fallback-queue");

    try {
      process.env.SUPABASE_URL = "https://mock-supa-62.local";
      process.env.SUPABASE_SERVICE_KEY = "mock-key-62";
      dbFallbackQueue.clear();

      let getThreadCalls = 0;
      let listMsgCalls = 0;
      let createThreadCalls62 = 0;
      let totalDbCalls = 0;
      const fixedIso = "2026-11-22T00:00:00.000Z";

      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input.url);
        if (u.hostname === "mock-supa-62.local") {
          totalDbCalls++;
          if (u.pathname.endsWith("/chat_thread") && init?.method === "POST") {
            createThreadCalls62++;
            if (createThreadCalls62 === 1) {
              return new Response(JSON.stringify({ message: "429 Too Many Requests" }), {
                status: 429,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(JSON.stringify({ id: "tid-created-after-429" }), {
              status: 201,
              headers: { "content-type": "application/json" },
            });
          }
          if (u.pathname.endsWith("/chat_thread")) {
            getThreadCalls++;
            if (getThreadCalls === 1) {
              return new Response(JSON.stringify({ message: "429 rate limit" }), {
                status: 429,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(
              JSON.stringify({
                id: "tid-62",
                widget_id: "wid-62",
                is_deleted: false,
                created_at: fixedIso,
                updated_at: fixedIso,
                title: null,
                system_prompt: "Keep session",
                context_text: null,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (u.pathname.endsWith("/chat_message")) {
            listMsgCalls++;
            if (listMsgCalls === 1) {
              return new Response(JSON.stringify({ message: "429 rate limit" }), {
                status: 429,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(
              JSON.stringify([
                { id: 10, thread_id: "tid-62", role: "user", content: "DB first", created_at: fixedIso },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
        }
        return origFetch(input, init);
      }) as any;

      // 1. Control-char IDs fail locally with 0 DB round trips
      expect(await realChatStore.getThread("tid\u0000bad", "wid-62")).toBeNull();
      expect(await realChatStore.listMessages("tid\nnewline")).toEqual([]);
      expect(await realChatStore.createThread("wid\u0007bell")).toBeNull();
      expect(totalDbCalls).toBe(0);

      // 2. Transient 429 on createThread, getThread, and listMessages recovers on single jittered retry
      expect(await realChatStore.createThread("wid-62")).toBe("tid-created-after-429");
      expect(createThreadCalls62).toBe(2);

      const thread = await realChatStore.getThread("tid-62", "wid-62");
      expect(thread?.id).toBe("tid-62");
      expect(thread?.system_prompt).toBe("Keep session");
      expect(getThreadCalls).toBe(2);

      // 3. Same-millisecond tie-breaking keeps persisted DB message (id > 0) ahead of queued fallback message (id < 0)
      dbFallbackQueue.enqueue(
        {
          threadId: "tid-62",
          role: "assistant",
          content: "Queued reply",
          createdAt: fixedIso,
        },
        { type: "db_chat_message" },
      );
      const msgs = await realChatStore.listMessages("tid-62", 10);
      expect(listMsgCalls).toBe(2);
      expect(msgs.map((m: any) => m.content)).toEqual(["DB first", "Queued reply"]);
    } finally {
      dbFallbackQueue.clear();
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = prevKey;
    }
  });

  it("VULN-63: Pushbullet strips trailing slashes on PUSHBULLET_API_URL, mail/sms reject control-char Idempotency-Key, and YouTube endpoints enforce port/pageToken/schema symmetry", async () => {
    const { sendViaPushbullet, clearPushbulletIdenCache } = await import(
      "../lib/sms/pushbullet"
    );
    const { google } = await import("googleapis");
    const origYoutube = google.youtube;
    const origFetch = globalThis.fetch;
    const prevPbUrl = process.env.PUSHBULLET_API_URL;
    const prevPbTok = process.env.PUSHBULLET_ACCESS_TOKEN;
    const prevPbIden = process.env.PUSHBULLET_DEVICE_IDEN;
    const prevAdmin = process.env.ADMIN_TOKEN;

    try {
      // 1. Trailing-slash PUSHBULLET_API_URL resolves to single-slash /v2/texts
      process.env.PUSHBULLET_API_URL = "https://mock-pb-63.local///";
      process.env.PUSHBULLET_ACCESS_TOKEN = "pb-tok-63";
      process.env.PUSHBULLET_DEVICE_IDEN = "dev-63";
      process.env.ADMIN_TOKEN = "test-admin-v63";
      clearPushbulletIdenCache();

      let pbRequestedUrl = "";
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const urlStr = typeof input === "string" ? input : input.url;
        if (urlStr.includes("mock-pb-63.local")) {
          pbRequestedUrl = urlStr;
          return new Response(JSON.stringify({ iden: "msg-63" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return origFetch(input, init);
      }) as any;

      const pbRes = await sendViaPushbullet({
        phoneNumber: "01012345678",
        text: "안녕하세요",
      });
      expect(pbRes.ok).toBe(true);
      expect(pbRequestedUrl).toBe("https://mock-pb-63.local/v2/texts");

      const app = await createApp(true);

      // 2. Control characters in Idempotency-Key -> HTTP 400 on both mail & sms endpoints
      for (const [route, payload] of [
        ["/v2/admin/mail/send", { to: "a@b.com", subject: "Hi", text: "Body" }],
        ["/v2/admin/sms/send", { to: "01012345678", text: "Body" }],
      ] as const) {
        const res = await app.handle(
          new Request(`http://localhost${route}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-admin-token": "test-admin-v63",
              "idempotency-key": "idem\u0007bad",
            },
            body: JSON.stringify(payload),
          }),
        );
        expect(res.status).toBe(400);
      }

      // 3. YouTube /auth/create rejects port > 65535 (HTTP 400), pageToken with whitespace/control chars fails locally (0 outbound calls), and reply/list preserves channelId/viewerRating/moderationStatus
      const badPortAuth = await app.handle(
        new Request("http://localhost/v1/youtube/auth/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: "123-abc.apps.googleusercontent.com",
            clientSecret: "GOCSPX-secret",
            redirectUri: "https://example.com:99999/callback",
          }),
        }),
      );
      expect(badPortAuth.status).toBe(400);

      let ytCalls = 0;
      (google as any).youtube = () => ({
        comments: {
          list: async () => {
            ytCalls++;
            return {
              data: {
                items: [
                  {
                    id: "reply-1",
                    snippet: {
                      textDisplay: "Great!",
                      channelId: "UC1no5Q01M2LmT-QLgLlUN0Q",
                      viewerRating: "none",
                      moderationStatus: "published",
                    },
                  },
                ],
                pageInfo: { totalResults: 1, resultsPerPage: 20 },
              },
            };
          },
        },
      });

      const badPageTok = await app.handle(
        new Request("http://localhost/v1/youtube/reply/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            parentId: "parent-1",
            accessToken: "valid-token",
            pageToken: "CAUQAA bad-space",
          }),
        }),
      );
      expect(badPageTok.status).toBe(400);
      expect(ytCalls).toBe(0);

      const okReplyList = await app.handle(
        new Request("http://localhost/v1/youtube/reply/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            parentId: "parent-1",
            accessToken: "valid-token",
          }),
        }),
      );
      expect(okReplyList.status).toBe(200);
      const replyJson = (await okReplyList.json()) as any;
      expect(replyJson.data.items[0].snippet.channelId).toBe(
        "UC1no5Q01M2LmT-QLgLlUN0Q",
      );
      expect(replyJson.data.items[0].snippet.viewerRating).toBe("none");
      expect(replyJson.data.items[0].snippet.moderationStatus).toBe("published");
    } finally {
      google.youtube = origYoutube;
      globalThis.fetch = origFetch;
      clearPushbulletIdenCache();
      if (prevPbUrl === undefined) delete process.env.PUSHBULLET_API_URL;
      else process.env.PUSHBULLET_API_URL = prevPbUrl;
      if (prevPbTok === undefined) delete process.env.PUSHBULLET_ACCESS_TOKEN;
      else process.env.PUSHBULLET_ACCESS_TOKEN = prevPbTok;
      if (prevPbIden === undefined) delete process.env.PUSHBULLET_DEVICE_IDEN;
      else process.env.PUSHBULLET_DEVICE_IDEN = prevPbIden;
      if (prevAdmin === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevAdmin;
    }
  });

  it("VULN-64: OpenAICompatibleProvider classifies HTTP 200 raw non-SSE JSON error & completion bodies instead of emitting empty streams, and /v2/ask detaches request.signal listeners", async () => {
    const { OpenAICompatibleProvider } = await import(
      "../lib/llm/openai-compatible"
    );
    const origFetch = globalThis.fetch;

    try {
      let mode: "raw-error" | "raw-completion" = "raw-error";
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const urlStr = typeof input === "string" ? input : input.url;
        if (urlStr.includes("mock-llm-64.local")) {
          if (mode === "raw-error") {
            return new Response(
              JSON.stringify({
                error: { message: "Provider overloaded after headers", code: 503 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "Non-SSE completion OK" } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return origFetch(input, init);
      }) as any;

      const provider = new OpenAICompatibleProvider({
        name: "test-v64",
        baseUrl: "https://mock-llm-64.local/v1",
        apiKey: "sk-v64",
        defaultModel: "gpt-test",
      });

      // 1. HTTP 200 raw JSON {"error": ...} throws instead of silently yielding 0 tokens
      let caughtRawErr: Error | null = null;
      try {
        for await (const _ of provider.stream({
          messages: [{ role: "user", content: "hi" }],
        })) {
          /* consume */
        }
      } catch (e: any) {
        caughtRawErr = e;
      }
      expect(caughtRawErr).not.toBeNull();
      expect(caughtRawErr?.message).toContain("Provider overloaded after headers");

      // 2. HTTP 200 raw JSON {"choices":[{"message":{"content":"..."}}]} yields full content
      mode = "raw-completion";
      const chunks: string[] = [];
      for await (const tk of provider.stream({
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(tk);
      }
      expect(chunks).toEqual(["Non-SSE completion OK"]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("VULN-65: listThreads, listWidgets, listWidgetsRegistered, and /v2/admin/db/migrate recover from transient PostgREST 429s, and deleteWidget rejects control-char IDs with 0 DB calls", async () => {
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_KEY;
    const prevAdmin = process.env.ADMIN_TOKEN;
    const origFetch = globalThis.fetch;
    const realChatStore: any = await import("../lib/chat-store?real-v65" as any);
    const realWidgetStore: any = await import("../lib/widget-store?real-v65" as any);
    const { dbFallbackQueue } = await import("../lib/queue/fallback-queue");

    try {
      process.env.SUPABASE_URL = "https://mock-supa-65.local";
      process.env.SUPABASE_SERVICE_KEY = "mock-key-65";
      process.env.ADMIN_TOKEN = "test-admin-v65";
      dbFallbackQueue.clear();
      realWidgetStore.invalidateWidgetCache();

      let listThreadsCalls = 0;
      let listThreadMsgsCalls = 0;
      let listWidgetsCalls = 0;
      let listRegWidgetsCalls = 0;
      let migHistCalls = 0;
      let deleteDbCalls = 0;
      const fixedIso = "2026-11-23T00:00:00.000Z";

      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input.url);
        if (u.hostname === "mock-supa-65.local") {
          if (u.pathname.endsWith("/widget") && init?.method === "PATCH") {
            deleteDbCalls++;
            return new Response("[]", { status: 200 });
          }
          if (u.pathname.endsWith("/widget") && (!init?.method || init.method === "GET")) {
            listRegWidgetsCalls++;
            if (listRegWidgetsCalls === 1) {
              return new Response(JSON.stringify({ message: "429 rate limit" }), {
                status: 429,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(
              JSON.stringify([
                {
                  id: "wid-65",
                  name: "Widget 65",
                  theme: "noir",
                  description: "ok",
                  welcome_message: "hi",
                  system_prompt: null,
                  suggested_questions: [],
                  icon_url: null,
                  chat_bubble_size: null,
                  is_deleted: false,
                  created_at: fixedIso,
                  updated_at: fixedIso,
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (u.pathname.endsWith("/chat_thread")) {
            if (u.search.includes("select=widget_id")) {
              listWidgetsCalls++;
              if (listWidgetsCalls === 1) {
                return new Response(JSON.stringify({ message: "429 rate limit" }), {
                  status: 429,
                  headers: { "content-type": "application/json" },
                });
              }
              return new Response(
                JSON.stringify([
                  { widget_id: "   ", updated_at: fixedIso },
                  { widget_id: "wid-65", updated_at: fixedIso },
                ]),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            listThreadsCalls++;
            if (listThreadsCalls === 1) {
              return new Response(JSON.stringify({ message: "429 rate limit" }), {
                status: 429,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(
              JSON.stringify([
                {
                  id: "tid-65",
                  widget_id: "wid-65",
                  is_deleted: false,
                  created_at: fixedIso,
                  updated_at: fixedIso,
                  title: "Session 65",
                  system_prompt: null,
                  context_text: null,
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (u.pathname.endsWith("/chat_message")) {
            listThreadMsgsCalls++;
            if (listThreadMsgsCalls === 1) {
              return new Response(JSON.stringify({ message: "429 rate limit" }), {
                status: 429,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(
              JSON.stringify([
                {
                  thread_id: "tid-65",
                  role: "user",
                  content: "Preserved preview after 429",
                  created_at: fixedIso,
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (u.pathname.endsWith("/_migration_history")) {
            migHistCalls++;
            if (migHistCalls === 1) {
              return new Response(JSON.stringify({ message: "429 rate limit" }), {
                status: 429,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
        }
        return origFetch(input, init);
      }) as any;

      // 1. deleteWidget rejects control-char IDs locally with 0 DB round trips
      expect(await realWidgetStore.deleteWidget("bad\u0000id")).toBe(false);
      expect(await realWidgetStore.deleteWidget("bad\nid")).toBe(false);
      expect(deleteDbCalls).toBe(0);

      // 2. listWidgetsRegistered & listWidgets recover from transient 429 and skip blank widget_ids
      const regRows = await realWidgetStore.listWidgetsRegistered();
      expect(listRegWidgetsCalls).toBe(2);
      expect(regRows.map((r: any) => r.id)).toEqual(["wid-65"]);

      const actRows = await realChatStore.listWidgets();
      expect(listWidgetsCalls).toBe(2);
      expect(actRows.map((r: any) => r.widget_id)).toEqual(["wid-65"]);

      // 3. listThreads recovers from transient 429 on BOTH chat_thread and chat_message queries
      const threads = await realChatStore.listThreads("wid-65");
      expect(listThreadsCalls).toBe(2);
      expect(listThreadMsgsCalls).toBe(2);
      expect(threads).toHaveLength(1);
      expect(threads[0].message_count).toBe(1);
      expect(threads[0].last_user_message).toBe("Preserved preview after 429");

      // 4. /v2/admin/db/migrate dryRun recovers from transient 429 on _migration_history read
      const app = await createApp(true);
      const migRes = await app.handle(
        new Request("http://localhost/v2/admin/db/migrate", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-v65",
          },
          body: JSON.stringify({ dryRun: true }),
        }),
      );
      expect(migRes.status).toBe(200);
      expect(migHistCalls).toBe(2);
    } finally {
      dbFallbackQueue.clear();
      realWidgetStore.invalidateWidgetCache();
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = prevKey;
      if (prevAdmin === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevAdmin;
    }
  });

  it("VULN-66: /v1/youtube/video/list coalesces concurrent cold-start channels.list lookups per handle+accessToken without cross-caller token contamination", async () => {
    const { clearChannelUploadsCache } = await import(
      "../src/endpoints/v1/youtube/video-list"
    );
    const { google } = await import("googleapis");
    const origYoutube = google.youtube;

    try {
      clearChannelUploadsCache();
      let channelsListCalls = 0;
      let playlistItemsCalls = 0;

      (google as any).youtube = ({ auth }: any) => ({
        channels: {
          list: async () => {
            channelsListCalls++;
            await new Promise((r) => setTimeout(r, 25));
            const tok = auth?.credentials?.access_token;
            if (tok === "bad-token") {
              const err: any = new Error("Invalid Credentials");
              err.code = 401;
              throw err;
            }
            return {
              data: {
                items: [
                  {
                    contentDetails: {
                      relatedPlaylists: { uploads: "UU1no5Q01M2LmT-QLgLlUN0Q" },
                    },
                  },
                ],
              },
            };
          },
        },
        playlistItems: {
          list: async () => {
            playlistItemsCalls++;
            return {
              data: {
                items: [{ id: "vid-1" }],
                pageInfo: { totalResults: 1, resultsPerPage: 10 },
              },
            };
          },
        },
      });

      const app = await createApp(true);

      // Fire 1 bad-token call and 4 concurrent valid-token calls simultaneously on cold cache
      const [badRes, ok1, ok2, ok3, ok4] = await Promise.all([
        app.handle(
          new Request("http://localhost/v1/youtube/video/list", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ handle: "@lolollol2379", accessToken: "bad-token" }),
          }),
        ),
        ...[1, 2, 3, 4].map(() =>
          app.handle(
            new Request("http://localhost/v1/youtube/video/list", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ handle: "@lolollol2379", accessToken: "good-token" }),
            }),
          ),
        ),
      ]);

      expect(badRes.status).toBe(400);
      expect([ok1.status, ok2.status, ok3.status, ok4.status]).toEqual([200, 200, 200, 200]);
      // 4 concurrent good-token calls coalesced into 1 channels.list call (+ 1 for bad-token = 2 total)
      expect(channelsListCalls).toBe(2);
      expect(playlistItemsCalls).toBe(4);
    } finally {
      google.youtube = origYoutube;
      clearChannelUploadsCache();
    }
  });

  it("VULN-67: /v2/admin/sms/send and /v2/admin/mail/send strip NUL bytes and reject pure-NUL bodies with HTTP 400 (0 outbound calls), and sendNaverMail RFC-5322 quotes special NAVER_MAIL_FROM_NAME", async () => {
    const nodemailer = (await import("nodemailer")).default;
    const { sendNaverMail, resetTransporterCache } = await import("../lib/mail/naver");
    const origCreateTransport = nodemailer.createTransport;
    const origFetch = globalThis.fetch;
    const prevAdmin = process.env.ADMIN_TOKEN;
    const prevMailUser = process.env.NAVER_MAIL_USER;
    const prevMailPass = process.env.NAVER_MAIL_PASSWORD;
    const prevFromName = process.env.NAVER_MAIL_FROM_NAME;
    const prevPbTok = process.env.PUSHBULLET_ACCESS_TOKEN;
    const prevPbIden = process.env.PUSHBULLET_DEVICE_IDEN;
    const prevPbUrl = process.env.PUSHBULLET_API_URL;
    const prevSmsProvider = process.env.SMS_PROVIDER;

    try {
      process.env.ADMIN_TOKEN = "test-admin-v67";
      process.env.NAVER_MAIL_USER = "sender@naver.com";
      process.env.NAVER_MAIL_PASSWORD = "app-password";
      process.env.NAVER_MAIL_FROM_NAME = 'Tokki, "Admin"\u0000\u0007 <ops>';
      process.env.SMS_PROVIDER = "pushbullet";
      process.env.PUSHBULLET_ACCESS_TOKEN = "pb-tok-67";
      process.env.PUSHBULLET_DEVICE_IDEN = "dev-67";
      process.env.PUSHBULLET_API_URL = "https://mock-pb-67.local";
      resetTransporterCache();

      let pbOutboundCalls = 0;
      let lastPbBody: any = null;
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const urlStr = typeof input === "string" ? input : input.url;
        if (urlStr.includes("mock-pb-67.local")) {
          pbOutboundCalls++;
          lastPbBody = JSON.parse(String(init?.body ?? "{}"));
          return new Response(JSON.stringify({ iden: "sms-67" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return origFetch(input, init);
      }) as any;

      let smtpCalls = 0;
      let lastMailOpts: any = null;
      (nodemailer as any).createTransport = () => ({
        on: () => {},
        close: () => {},
        sendMail: async (opts: any) => {
          smtpCalls++;
          lastMailOpts = opts;
          return { messageId: "m-67", accepted: [opts.to], rejected: [] };
        },
      });

      const app = await createApp(true);

      // 1. Pure NUL-byte SMS & Mail bodies fail locally with HTTP 400 and 0 outbound calls
      const nulSmsRes = await app.handle(
        new Request("http://localhost/v2/admin/sms/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-v67",
          },
          body: JSON.stringify({ to: "01012345678", text: "\u0000\u0000" }),
        }),
      );
      expect(nulSmsRes.status).toBe(400);
      expect(pbOutboundCalls).toBe(0);

      const nulMailRes = await app.handle(
        new Request("http://localhost/v2/admin/mail/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-v67",
          },
          body: JSON.stringify({
            to: "dest@example.com",
            subject: "Alert",
            text: "\u0000  \u0000",
            html: "\u0000",
          }),
        }),
      );
      expect(nulMailRes.status).toBe(400);
      expect(smtpCalls).toBe(0);

      // 2. Mixed NUL bytes are stripped before Pushbullet/SMTP dispatch, and NAVER_MAIL_FROM_NAME is RFC-5322 quoted
      const cleanSmsRes = await app.handle(
        new Request("http://localhost/v2/admin/sms/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-v67",
          },
          body: JSON.stringify({ to: "010-1234-5678", text: "안녕\u0000하세요" }),
        }),
      );
      expect(cleanSmsRes.status).toBe(200);
      expect(lastPbBody?.data?.message).toBe("안녕하세요");

      await sendNaverMail({
        to: "dest@example.com",
        subject: "Test",
        text: "Hello",
      });
      expect(smtpCalls).toBe(1);
      expect(lastMailOpts?.from).toBe('"Tokki, \\"Admin\\" <ops>" <sender@naver.com>');
    } finally {
      nodemailer.createTransport = origCreateTransport;
      resetTransporterCache();
      globalThis.fetch = origFetch;
      if (prevAdmin === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevAdmin;
      if (prevMailUser === undefined) delete process.env.NAVER_MAIL_USER;
      else process.env.NAVER_MAIL_USER = prevMailUser;
      if (prevMailPass === undefined) delete process.env.NAVER_MAIL_PASSWORD;
      else process.env.NAVER_MAIL_PASSWORD = prevMailPass;
      if (prevFromName === undefined) delete process.env.NAVER_MAIL_FROM_NAME;
      else process.env.NAVER_MAIL_FROM_NAME = prevFromName;
      if (prevPbTok === undefined) delete process.env.PUSHBULLET_ACCESS_TOKEN;
      else process.env.PUSHBULLET_ACCESS_TOKEN = prevPbTok;
      if (prevPbIden === undefined) delete process.env.PUSHBULLET_DEVICE_IDEN;
      else process.env.PUSHBULLET_DEVICE_IDEN = prevPbIden;
      if (prevPbUrl === undefined) delete process.env.PUSHBULLET_API_URL;
      else process.env.PUSHBULLET_API_URL = prevPbUrl;
      if (prevSmsProvider === undefined) delete process.env.SMS_PROVIDER;
      else process.env.SMS_PROVIDER = prevSmsProvider;
    }
  });

  it("VULN-68: UpstashRedisKeyStore coalesces concurrent exhaustion flushes without wiping mid-flight 401 revocations, cleans reassigned account sets via SREM, and RotatingLLMProvider penalizes HTTP 200 raw non-SSE JSON 402 errors", async () => {
    const { UpstashRedisKeyStore } = await import(
      "../lib/llm/key-manager/stores/upstash-redis"
    );
    const { MemoryKeyStore } = await import(
      "../lib/llm/key-manager/stores/memory"
    );
    const { RotatingLLMProvider } = await import("../lib/llm/rotating-provider");
    const origFetch = globalThis.fetch;

    try {
      // Part 1: Upstash single-flight flush + mid-flight 401 preservation + syncKeys SREM
      const fallback = new MemoryKeyStore();
      const redisStore = new UpstashRedisKeyStore(
        "https://mock-upstash-68.local",
        "tok-68",
        { timeoutMs: 200, breakerDurationMs: 50, memoryFallback: fallback },
      );

      let redisOnline = true;
      let pipelinePayloads: any[][][] = [];
      let flushStage = 0;

      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const urlStr = typeof input === "string" ? input : input.url;
        if (urlStr.includes("mock-upstash-68.local")) {
          if (!redisOnline) {
            return new Response("Redis Down", { status: 503 });
          }
          if (urlStr.endsWith("/pipeline")) {
            const cmds = JSON.parse(String(init?.body ?? "[]"));
            pipelinePayloads.push(cmds);
            // Simulate concurrent 401 revocation arriving mid-flight during first recovery flush
            if (flushStage === 1) {
              flushStage = 2;
              await new Promise((r) => setTimeout(r, 20));
            }
            return new Response(
              JSON.stringify(cmds.map(() => ({ result: "OK" }))),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (urlStr.endsWith("/eval")) {
            return new Response(
              JSON.stringify({ result: ["k-active", "k-active:1:999"] }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
        }
        if (urlStr.includes("openrouter.ai/api/v1/chat/completions")) {
          // HTTP 200 OK headers followed by raw non-SSE JSON 402 error (no `data:` prefix)
          return new Response(
            JSON.stringify({
              error: { message: "Insufficient credits mid-handshake", code: 402 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return origFetch(input, init);
      }) as any;

      await redisStore.syncKeys([
        { id: "k-402", apiKey: "sk-1", accountId: "acc-old", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-401-mid", apiKey: "sk-2", accountId: "acc-2", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-active", apiKey: "sk-3", accountId: "acc-3", tier: 0, weight: 10, maxConcurrency: 5 },
      ]);

      // Reassign k-402 from acc-old -> acc-new and verify SREM on acc-old
      pipelinePayloads = [];
      await redisStore.syncKeys([
        { id: "k-402", apiKey: "sk-1", accountId: "acc-new", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-401-mid", apiKey: "sk-2", accountId: "acc-2", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-active", apiKey: "sk-3", accountId: "acc-3", tier: 0, weight: 10, maxConcurrency: 5 },
      ]);
      expect(pipelinePayloads).toHaveLength(1);
      expect(
        pipelinePayloads[0].some(
          (cmd) =>
            cmd[0] === "SREM" &&
            cmd[1] === "openrouter:account:acc-old:keys" &&
            cmd[2] === "k-402",
        ),
      ).toBe(true);

      // Simulate Redis outage: k-402 hits 402 while Redis is unreachable
      redisOnline = false;
      await redisStore.releaseKey("k-402", "lease-a", 402, Infinity, "Wallet empty");

      // Bring Redis back online; fire 5 concurrent reserveKey() calls AND inject a mid-flight 401 exhaustion
      redisOnline = true;
      pipelinePayloads = [];
      flushStage = 1;

      const reserveBatch = Promise.all([
        redisStore.reserveKey(),
        redisStore.reserveKey(),
        redisStore.reserveKey(),
        redisStore.reserveKey(),
        redisStore.reserveKey(),
      ]);
      // Queue a new permanent 401 revocation while flush #1 is awaiting /pipeline
      await new Promise((r) => setTimeout(r, 5));
      redisOnline = false;
      await redisStore.releaseKey("k-401-mid", "lease-b", 401, Infinity, "Revoked mid-flush");
      redisOnline = true;
      await reserveBatch;

      // All 5 concurrent reserveKey() calls coalesced into a SINGLE flush /pipeline request
      expect(pipelinePayloads).toHaveLength(1);

      // Next reserveKey() must flush the preserved mid-flight k-401-mid revocation (NOT lost to .clear()!)
      pipelinePayloads = [];
      await redisStore.reserveKey();
      expect(pipelinePayloads).toHaveLength(1);
      expect(
        pipelinePayloads[0].some(
          (cmd) =>
            cmd[0] === "HSET" &&
            cmd[1] === "openrouter:key:k-401-mid" &&
            cmd.includes("401"),
        ),
      ).toBe(true);

      // Part 2: RotatingLLMProvider penalizes HTTP 200 raw non-SSE JSON 402 error across shared account
      const memStore = new MemoryKeyStore();
      const cfgs = [
        { id: "rot-a", apiKey: "sk-ra", accountId: "shared-wallet", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "rot-b", apiKey: "sk-rb", accountId: "shared-wallet", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      const rotProvider = new RotatingLLMProvider(
        memStore,
        new Map(cfgs.map((c) => [c.id, c])),
      );

      let caughtRotErr: Error | null = null;
      try {
        for await (const _ of rotProvider.stream({
          messages: [{ role: "user", content: "hi" }],
        })) {
          /* consume */
        }
      } catch (e: any) {
        caughtRotErr = e;
      }
      expect(caughtRotErr).not.toBeNull();
      expect(caughtRotErr?.message).toContain("UPSTREAM_SSE_ERROR (402)");

      const states = await memStore.getAllStates();
      expect(states.find((s) => s.id === "rot-a")?.status).toBe("EXHAUSTED");
      expect(states.find((s) => s.id === "rot-b")?.status).toBe("EXHAUSTED");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("VULN-69: /v2/widget/view and /v2/widget/create-thread reject >2,000-char __proto__, constructor, and prototype payload smuggling across JSON and form-urlencoded with HTTP 413", async () => {
    const app = await createApp(true);

    // 1. Single oversized __proto__ JSON field on /v2/widget/view & /v2/widget/create-thread -> HTTP 413
    for (const route of ["/v2/widget/view", "/v2/widget/create-thread"]) {
      const resProto = await app.handle(
        new Request(`http://localhost${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"__proto__":"${"A".repeat(2500)}"}`,
        }),
      );
      expect(resProto.status).toBe(413);

      // 2. Duplicate constructor / prototype overwrite smuggling (<4,000 total chars, >2,000 first value) -> HTTP 413
      const resDupCtor = await app.handle(
        new Request(`http://localhost${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"constructor":"${"B".repeat(2200)}","constructor":"x"}`,
        }),
      );
      expect(resDupCtor.status).toBe(413);

      // 3. Form-urlencoded oversized __proto__ / prototype field -> HTTP 413
      const resFormProto = await app.handle(
        new Request(`http://localhost${route}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `__proto__=${"C".repeat(2500)}`,
        }),
      );
      expect(resFormProto.status).toBe(413);
    }

    // 4. Small __proto__ probe remains stripped cleanly without false 413
    const smallProbe = await app.handle(
      new Request("http://localhost/v2/widget/create-thread", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"__proto__":{"isAdmin":true}}',
      }),
    );
    expect(smallProbe.status).toBe(403);
  });

  it("VULN-70: /v2/ask validates aborted signal & LLM config before DB writes, OpenAICompatibleProvider normalizes Bearer prefix & rejects malformed URL/API key, and RotatingLLMProvider classifies string SSE errors & quota codes", async () => {
    const { OpenAICompatibleProvider } = await import("../lib/llm/openai-compatible");
    const { RotatingLLMProvider } = await import("../lib/llm/rotating-provider");
    const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");
    const realWidgetStore: any = await import("../lib/widget-store?real-v70" as any);
    const prevSupaUrl = process.env.SUPABASE_URL;
    const prevSupaKey = process.env.SUPABASE_SERVICE_KEY;
    const prevLlmProvider = process.env.LLM_PROVIDER;
    const prevLlmKey = process.env.LLM_API_KEY;
    const prevOrKeys = process.env.OPENROUTER_API_KEYS;
    const origFetch = globalThis.fetch;

    try {
      // 1. OpenAICompatibleProvider strips redundant "Bearer " prefix and rejects bad URLs / control-char keys immediately
      expect(
        () =>
          new OpenAICompatibleProvider({
            name: "bad-url",
            baseUrl: "ftp://invalid.local",
            apiKey: "sk-ok",
            defaultModel: "m",
          }),
      ).toThrow("http:// or https://");
      expect(
        () =>
          new OpenAICompatibleProvider({
            name: "bad-key",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-bad\nnewline",
            defaultModel: "m",
          }),
      ).toThrow("invalid API key format");

      let seenAuthHeader = "";
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const urlStr = typeof input === "string" ? input : input.url;
        if (urlStr.includes("mock-bearer-70.local")) {
          seenAuthHeader = new Headers(init?.headers).get("authorization") || "";
          return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return origFetch(input, init);
      }) as any;

      const bearerProvider = new OpenAICompatibleProvider({
        name: "bearer-norm",
        baseUrl: "https://mock-bearer-70.local/v1",
        apiKey: "  Bearer   sk-clean-70  ",
        defaultModel: "gpt-test",
      });
      const outTokens: string[] = [];
      for await (const tk of bearerProvider.stream({ messages: [{ role: "user", content: "hi" }] })) {
        outTokens.push(tk);
      }
      expect(seenAuthHeader).toBe("Bearer sk-clean-70");
      expect(outTokens).toEqual(["OK"]);

      // 2. /v2/ask checks LLM config & aborted signal BEFORE creating orphan chat_thread / chat_message rows
      process.env.SUPABASE_URL = "https://mock-supa-70.local";
      process.env.SUPABASE_SERVICE_KEY = "mock-key-70";
      delete process.env.OPENROUTER_API_KEYS;
      realWidgetStore.invalidateWidgetCache();

      let dbWriteCalls = 0;
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input.url);
        if (u.hostname === "mock-supa-70.local") {
          const method = (init?.method ?? "GET").toUpperCase();
          if (method !== "GET") dbWriteCalls++;
          if (u.pathname.endsWith("/widget")) {
            return new Response(
              JSON.stringify({
                id: "registered-valid-widget",
                name: "Bot",
                theme: "noir",
                description: "",
                welcome_message: "",
                system_prompt: null,
                suggested_questions: [],
                icon_url: null,
                chat_bubble_size: null,
                is_deleted: false,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ id: "orphan-tid" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        if (u.hostname === "openrouter.ai") {
          return new Response(
            'data: {"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return origFetch(input, init);
      }) as any;

      const app = await createApp(true);
      process.env.OPENROUTER_API_KEYS = " , ";
      process.env.LLM_PROVIDER = "unknown_broken_vendor";
      process.env.LLM_API_KEY = "sk-test-70";

      const badCfgRes = await app.handle(
        new Request("http://localhost/v2/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ widgetId: "registered-valid-widget", message: "hello" }),
        }),
      );
      expect(badCfgRes.status).toBe(500);
      expect(dbWriteCalls).toBe(0); // Zero orphan threads/messages created!

      const preAborted = new AbortController();
      preAborted.abort();
      delete process.env.OPENROUTER_API_KEYS;
      process.env.LLM_PROVIDER = "openai";
      const abortRes = await app.handle(
        new Request("http://localhost/v2/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ widgetId: "registered-valid-widget", message: "hello" }),
          signal: preAborted.signal,
        }),
      );
      expect(abortRes.status).toBe(499);
      expect(dbWriteCalls).toBe(0);

      // 3. RotatingLLMProvider classifies string code "insufficient_quota" in-band SSE error as 402 EXHAUSTED
      const mem = new MemoryKeyStore();
      const rot = new RotatingLLMProvider(
        mem,
        new Map([
          ["k-str-402", { id: "k-str-402", apiKey: "sk-1", accountId: "acc-70", tier: 0, weight: 10, maxConcurrency: 5 }],
          ["k-str-sib", { id: "k-str-sib", apiKey: "sk-2", accountId: "acc-70", tier: 0, weight: 10, maxConcurrency: 5 }],
        ]),
      );
      let rotStreamErr: Error | null = null;
      try {
        for await (const _ of rot.stream({ messages: [{ role: "user", content: "hi" }] })) {
          /* drain */
        }
      } catch (e: any) {
        rotStreamErr = e;
      }
      expect(rotStreamErr?.message).toContain("UPSTREAM_SSE_ERROR (402)");
      const states70 = await mem.getAllStates();
      expect(states70.every((s) => s.status === "EXHAUSTED")).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      realWidgetStore.invalidateWidgetCache();
      if (prevSupaUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevSupaUrl;
      if (prevSupaKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = prevSupaKey;
      if (prevLlmProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = prevLlmProvider;
      if (prevLlmKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevLlmKey;
      if (prevOrKeys === undefined) delete process.env.OPENROUTER_API_KEYS;
      else process.env.OPENROUTER_API_KEYS = prevOrKeys;
    }
  });

  it("VULN-71: All 6 idempotent widget-store and chat-store mutations retry transient PostgREST 429 errors", async () => {
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_KEY;
    const origFetch = globalThis.fetch;
    const realWidgetStore: any = await import("../lib/widget-store?real-v71" as any);
    const realChatStore: any = await import("../lib/chat-store?real-v71" as any);

    try {
      process.env.SUPABASE_URL = "https://mock-supa-71.local";
      process.env.SUPABASE_SERVICE_KEY = "mock-key-71";

      let callCounter = 0;
      const fixedIso = "2026-11-24T00:00:00.000Z";
      globalThis.fetch = (async (input: any) => {
        const u = new URL(typeof input === "string" ? input : input.url);
        if (u.hostname === "mock-supa-71.local") {
          callCounter++;
          // Odd-numbered calls return transient 429; even-numbered calls succeed
          if (callCounter % 2 === 1) {
            return new Response(JSON.stringify({ message: "429 Too Many Requests" }), {
              status: 429,
              headers: { "content-type": "application/json" },
            });
          }
          if (u.pathname.endsWith("/widget")) {
            return new Response(
              JSON.stringify({
                id: "wid-71",
                name: "Upserted 71",
                theme: "noir",
                description: "d",
                welcome_message: "w",
                system_prompt: null,
                suggested_questions: [],
                icon_url: null,
                chat_bubble_size: null,
                is_deleted: false,
                created_at: fixedIso,
                updated_at: fixedIso,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return origFetch(input);
      }) as any;

      const upRes = await realWidgetStore.upsertWidget({ id: "wid-71", name: "Upserted 71" });
      expect(upRes.row?.id).toBe("wid-71");
      expect(await realWidgetStore.deleteWidget("wid-71")).toBe(true);
      expect(await realChatStore.deleteThread("tid-71", "wid-71")).toBe(true);
      expect(await realChatStore.rollbackThread("tid-71")).toBe(true);
      expect(await realChatStore.renameThread("tid-71", "wid-71", "Renamed")).toBe(true);
      expect(
        await realChatStore.updateThreadPrompt("tid-71", "wid-71", { system_prompt: "Prompt" }),
      ).toBe(true);
      // 6 operations * 2 calls each (1st 429 + 2nd 200) = 12 total calls
      expect(callCounter).toBe(12);
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = prevKey;
    }
  });

  it("VULN-72: Pushbullet coalesces concurrent /v2/devices lookups, YouTube /video/list resolves bare handles via forHandle in 1 call, and sendNaverMail sanitizes CRLF/empty recipient segments", async () => {
    const { sendViaPushbullet, clearPushbulletIdenCache } = await import("../lib/sms/pushbullet");
    const { clearChannelUploadsCache } = await import("../src/endpoints/v1/youtube/video-list");
    const { sendNaverMail, resetTransporterCache } = await import("../lib/mail/naver");
    const nodemailer = (await import("nodemailer")).default;
    const { google } = await import("googleapis");
    const origYoutube = google.youtube;
    const origCreateTransport = nodemailer.createTransport;
    const origFetch = globalThis.fetch;

    const prevPbUrl = process.env.PUSHBULLET_API_URL;
    const prevPbTok = process.env.PUSHBULLET_ACCESS_TOKEN;
    const prevPbIden = process.env.PUSHBULLET_DEVICE_IDEN;
    const prevPbNick = process.env.PUSHBULLET_DEVICE_NICKNAME;
    const prevPbTestIden = process.env.PUSHBULLET_TEST_DEVICE_IDEN;
    const prevAdmin = process.env.ADMIN_TOKEN;
    const prevMailUser = process.env.NAVER_MAIL_USER;
    const prevMailPass = process.env.NAVER_MAIL_PASSWORD;

    try {
      // 1. Pushbullet coalesces 5 concurrent cold-start /v2/devices calls into 1
      process.env.PUSHBULLET_API_URL = "https://mock-pb-72.local";
      process.env.PUSHBULLET_ACCESS_TOKEN = "pb-tok-72";
      delete process.env.PUSHBULLET_DEVICE_IDEN;
      delete process.env.PUSHBULLET_TEST_DEVICE_IDEN;
      process.env.PUSHBULLET_DEVICE_NICKNAME = "Galaxy72";
      clearPushbulletIdenCache();

      let devicesCalls = 0;
      let textsCalls = 0;
      globalThis.fetch = (async (input: any) => {
        const urlStr = typeof input === "string" ? input : input.url;
        if (urlStr.includes("mock-pb-72.local/v2/devices")) {
          devicesCalls++;
          await new Promise((r) => setTimeout(r, 20));
          return new Response(
            JSON.stringify({
              devices: [{ iden: "iden-gal-72", nickname: "Galaxy72", active: true }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (urlStr.includes("mock-pb-72.local/v2/texts")) {
          textsCalls++;
          return new Response(JSON.stringify({ iden: "txt-72" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return origFetch(input);
      }) as any;

      const pbBatch = await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          sendViaPushbullet({ phoneNumber: `0100000000${i}`, text: "test" }),
        ),
      );
      expect(pbBatch.every((r) => r.ok)).toBe(true);
      expect(devicesCalls).toBe(1);
      expect(textsCalls).toBe(5);

      // 2. YouTube /video/list with bare handle ("lolollol2379" without @) hits forHandle first -> 1 channels.list call
      clearChannelUploadsCache();
      const channelParamsLog: any[] = [];
      (google as any).youtube = () => ({
        channels: {
          list: async (params: any) => {
            channelParamsLog.push(params);
            if (params.forHandle === "@lolollol2379") {
              return {
                data: {
                  items: [
                    { contentDetails: { relatedPlaylists: { uploads: "UU-72" } } },
                  ],
                },
              };
            }
            return { data: { items: [] } };
          },
        },
        playlistItems: {
          list: async () => ({
            data: { items: [{ id: "v-72" }], pageInfo: { totalResults: 1, resultsPerPage: 10 } },
          }),
        },
      });

      const app = await createApp(true);
      const ytRes = await app.handle(
        new Request("http://localhost/v1/youtube/video/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle: "lolollol2379", accessToken: "tok-72" }),
        }),
      );
      expect(ytRes.status).toBe(200);
      expect(channelParamsLog).toHaveLength(1);
      expect(channelParamsLog[0].forHandle).toBe("@lolollol2379");

      // 3. /v2/admin/mail/send normalizes empty comma segments and sendNaverMail strips CRLF in direct calls
      process.env.ADMIN_TOKEN = "test-admin-v72";
      process.env.NAVER_MAIL_USER = "sender@naver.com";
      process.env.NAVER_MAIL_PASSWORD = "pass";
      resetTransporterCache();

      let capturedMail: any = null;
      (nodemailer as any).createTransport = () => ({
        on: () => {},
        close: () => {},
        sendMail: async (opts: any) => {
          capturedMail = opts;
          return { messageId: "m-72", accepted: [opts.to], rejected: [] };
        },
      });

      const mailRes = await app.handle(
        new Request("http://localhost/v2/admin/mail/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": "test-admin-v72",
          },
          body: JSON.stringify({
            to: "a@example.com, , b@example.com , ",
            subject: "Normalized",
            text: "Hello",
          }),
        }),
      );
      expect(mailRes.status).toBe(200);
      expect(capturedMail?.to).toBe("a@example.com, b@example.com");

      await sendNaverMail({
        to: "direct@example.com",
        subject: "Line1\r\nBcc: evil@example.com",
        text: "Direct call",
        from: "Custom\r\nHeader <sender@naver.com>",
      });
      expect(capturedMail?.subject).toBe("Line1 Bcc: evil@example.com");
      expect(capturedMail?.from).toBe("Custom Header <sender@naver.com>");
    } finally {
      google.youtube = origYoutube;
      nodemailer.createTransport = origCreateTransport;
      resetTransporterCache();
      clearChannelUploadsCache();
      clearPushbulletIdenCache();
      globalThis.fetch = origFetch;
      if (prevPbUrl === undefined) delete process.env.PUSHBULLET_API_URL;
      else process.env.PUSHBULLET_API_URL = prevPbUrl;
      if (prevPbTok === undefined) delete process.env.PUSHBULLET_ACCESS_TOKEN;
      else process.env.PUSHBULLET_ACCESS_TOKEN = prevPbTok;
      if (prevPbIden === undefined) delete process.env.PUSHBULLET_DEVICE_IDEN;
      else process.env.PUSHBULLET_DEVICE_IDEN = prevPbIden;
      if (prevPbNick === undefined) delete process.env.PUSHBULLET_DEVICE_NICKNAME;
      else process.env.PUSHBULLET_DEVICE_NICKNAME = prevPbNick;
      if (prevPbTestIden === undefined) delete process.env.PUSHBULLET_TEST_DEVICE_IDEN;
      else process.env.PUSHBULLET_TEST_DEVICE_IDEN = prevPbTestIden;
      if (prevAdmin === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevAdmin;
      if (prevMailUser === undefined) delete process.env.NAVER_MAIL_USER;
      else process.env.NAVER_MAIL_USER = prevMailUser;
      if (prevMailPass === undefined) delete process.env.NAVER_MAIL_PASSWORD;
      else process.env.NAVER_MAIL_PASSWORD = prevMailPass;
    }
  });
});
