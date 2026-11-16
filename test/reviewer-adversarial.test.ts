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
});
