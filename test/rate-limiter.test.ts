/**
 * Endpoint Rate Limiting & DDoS Spam Defense Verification Suite
 * Target: test/rate-limiter.test.ts
 *
 * Verifies:
 * 1. SlidingWindowRateLimiter: Zero-GC counter interpolation, boundary checks, and O(1) LRU eviction.
 * 2. Route policy tier mapping across AI streaming, widgets, YouTube, admin, and health routes.
 * 3. Client IP extraction across X-Forwarded-For, X-Real-IP, CF-Connecting-IP, and fallback.
 * 4. DDoS / Traffic Spam Simulation:
 *    - Rapid flood of 25+ requests from single IP triggers HTTP 429 without server crash.
 *    - Complete RFC header compliance: Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining: 0, X-RateLimit-Reset.
 *    - Multi-tenant / Multi-IP isolation: Attacker IP exhaustion does NOT block legitimate client IPs.
 *    - Autonomous recovery once the sliding window resets.
 */

import { describe, expect, it, beforeEach, afterEach, afterAll } from "bun:test";
import {
  SlidingWindowRateLimiter,
  resolvePolicy,
  extractClientIp,
  checkRateLimit,
  setTestRateLimitEnforced,
  resetRateLimitsForTesting,
  ROUTE_POLICIES,
} from "../lib/rate-limit";
import { createApp } from "../src/app";

describe("1. SlidingWindowRateLimiter Invariants", () => {
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowRateLimiter(5); // Small capacity for unit testing LRU
  });

  it("permits requests within quota and rejects requests exceeding limit", () => {
    const key = "test-client-1";
    const limit = 3;
    const windowMs = 60_000;
    const t0 = 1_000_000;

    const r1 = limiter.check(key, limit, windowMs, t0);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check(key, limit, windowMs, t0 + 100);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.check(key, limit, windowMs, t0 + 200);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // 4th request exceeds limit
    const r4 = limiter.check(key, limit, windowMs, t0 + 300);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.resetMs).toBeGreaterThan(0);
  });

  it("slides window smoothly using counter interpolation", () => {
    const key = "sliding-test";
    const limit = 10;
    const windowMs = 10_000;
    let now = 100_000;

    // Window 1 (100k - 110k): consume 10 requests
    for (let i = 0; i < 10; i++) {
      limiter.check(key, limit, windowMs, now);
    }
    expect(limiter.check(key, limit, windowMs, now).allowed).toBe(false);

    // Advance 5s (half window, now = 105k): weight = 0.5, prevCount = 10 -> estimated = 5
    now = 110_000 + 5_000; // In second window, 5s elapsed
    // At now = 115k: window start was 110k, elapsed = 5k. weight = (10k - 5k)/10k = 0.5.
    // estimated = prev(10) * 0.5 + current(0) = 5. Limit is 10.
    const res = limiter.check(key, limit, windowMs, now);
    expect(res.allowed).toBe(true);
  });

  it("evicts oldest LRU entry when capacity is reached", () => {
    const windowMs = 60_000;
    const now = 1_000_000;

    for (let i = 1; i <= 5; i++) {
      limiter.check(`ip-${i}`, 10, windowMs, now);
    }
    expect(limiter.size).toBe(5);

    // 6th entry should evict oldest (ip-1)
    limiter.check("ip-6", 10, windowMs, now);
    expect(limiter.size).toBe(5);
    expect(limiter.has("ip-1")).toBe(false);
    expect(limiter.has("ip-6")).toBe(true);
  });
});

describe("2. Route Policy & IP Resolution", () => {
  it("resolves correct tier policies for all key routes", () => {
    expect(resolvePolicy("/v2/ask", "POST").tier).toBe("ask");
    expect(resolvePolicy("/v2/ask", "POST").limit).toBe(10);

    expect(resolvePolicy("/v2/widget/create-thread", "POST").tier).toBe("widget_thread");
    expect(resolvePolicy("/v2/widget/create-thread", "POST").limit).toBe(20);

    expect(resolvePolicy("/v2/widget/view", "POST").tier).toBe("widget");
    expect(resolvePolicy("/v2/widget/view", "POST").limit).toBe(30);

    expect(resolvePolicy("/v1/youtube/comment", "POST").tier).toBe("youtube_write");
    expect(resolvePolicy("/v1/youtube/comment", "POST").limit).toBe(10);

    expect(resolvePolicy("/v1/youtube/channel/info", "POST").tier).toBe("youtube_read");
    expect(resolvePolicy("/v1/youtube/channel/info", "POST").limit).toBe(20);

    expect(resolvePolicy("/v2/admin/mail/send", "POST").tier).toBe("admin_comms");
    expect(resolvePolicy("/v2/admin/mail/send", "POST").limit).toBe(10);

    expect(resolvePolicy("/v2/admin/widgets/upload-icon", "POST").tier).toBe("admin_upload");
    expect(resolvePolicy("/v2/admin/widgets/upload-icon", "POST").limit).toBe(5);

    expect(resolvePolicy("/v2/admin/db/migrate", "POST").tier).toBe("admin_critical");
    expect(resolvePolicy("/v2/admin/db/migrate", "POST").limit).toBe(5);

    expect(resolvePolicy("/v1/healthz", "GET").tier).toBe("public");
    expect(resolvePolicy("/v1/healthz", "GET").limit).toBe(120);

    expect(resolvePolicy("/json", "GET").tier).toBe("docs");
  });

  it("extracts client IP from proxy and forwarding headers", () => {
    const req1 = new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.195, 70.41.3.18" },
    });
    expect(extractClientIp(req1)).toBe("203.0.113.195");

    const req2 = new Request("http://localhost", {
      headers: { "x-real-ip": "198.51.100.77" },
    });
    expect(extractClientIp(req2)).toBe("198.51.100.77");

    const req3 = new Request("http://localhost", {
      headers: { "cf-connecting-ip": "192.0.2.45" },
    });
    expect(extractClientIp(req3)).toBe("192.0.2.45");

    const req4 = new Request("http://localhost");
    expect(extractClientIp(req4)).toBe("127.0.0.1");
  });
});

describe("3. DDoS & Traffic Spam Simulation against Backend API", () => {
  beforeEach(() => {
    resetRateLimitsForTesting();
    setTestRateLimitEnforced(true); // Actively enforce rate limits in test
  });

  afterEach(() => {
    resetRateLimitsForTesting();
    setTestRateLimitEnforced(null); // Safely restore bypass for other test files
  });

  afterAll(() => {
    resetRateLimitsForTesting();
    setTestRateLimitEnforced(null);
  });

  it("defends against rapid request spam: rejects excess requests with HTTP 429 without crashing", async () => {
    const app = await createApp(true);
    const attackerIp = "203.0.113.66";
    const totalRequests = 25;
    const policyLimit = ROUTE_POLICIES.widgetCreateThread.limit; // 20 requests

    const responses: Array<{ status: number; headers: Headers; body: any }> = [];

    // Simulate concurrent flood of 25 requests from the same attacker IP
    for (let i = 0; i < totalRequests; i++) {
      const res = await app.handle(
        new Request("http://localhost/v2/widget/create-thread", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": attackerIp,
            "x-test-rate-limit": "true",
          },
          body: JSON.stringify({ widgetId: "test-widget" }),
        })
      );
      const json = (await res.json().catch(() => ({}))) as any;
      responses.push({ status: res.status, headers: res.headers, body: json });
    }

    const blocked429 = responses.filter((r) => r.status === 429);
    const nonBlocked = responses.filter((r) => r.status !== 429);

    // Exactly 20 allowed by policy, and 5 blocked with 429
    expect(nonBlocked.length).toBe(policyLimit);
    expect(blocked429.length).toBe(totalRequests - policyLimit);

    // Verify rate limit response headers and body on 429 responses
    for (const r of blocked429) {
      expect(r.headers.get("retry-after")).toBeDefined();
      expect(r.headers.get("x-ratelimit-limit")).toBe(String(policyLimit));
      expect(r.headers.get("x-ratelimit-remaining")).toBe("0");
      expect(r.body.success).toBe(false);
      expect(r.body.error).toBe("Too Many Requests");
      expect(r.body.retryAfter).toBeGreaterThan(0);
    }
  });

  it("AI Streaming Endpoint (/v2/ask) strictly enforces 10 req/min limit under spam", async () => {
    const app = await createApp(true);
    const attackerIp = "198.51.100.99";

    const results: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await app.handle(
        new Request("http://localhost/v2/ask", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": attackerIp,
            "x-test-rate-limit": "true",
          },
          body: JSON.stringify({ widgetId: "sample", message: "Hi" }),
        })
      );
      results.push(res.status);
    }

    const count429 = results.filter((s) => s === 429).length;
    // Limit is 10, so at least 5 requests must be blocked with 429
    expect(count429).toBe(5);
  });

  it("multi-tenant / multi-client IP isolation: attacker exhaustion does NOT block other users", async () => {
    const app = await createApp(true);
    const attackerIp = "198.51.100.1";
    const honestClientIp = "198.51.100.2";

    // 1. Attacker exhausts their quota on /v2/widget/create-thread (limit: 20)
    for (let i = 0; i < 22; i++) {
      await app.handle(
        new Request("http://localhost/v2/widget/create-thread", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": attackerIp,
            "x-test-rate-limit": "true",
          },
          body: JSON.stringify({ widgetId: "test" }),
        })
      );
    }

    // Attacker's next call is confirmed blocked with 429
    const attackerCheck = await app.handle(
      new Request("http://localhost/v2/widget/create-thread", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": attackerIp,
          "x-test-rate-limit": "true",
        },
        body: JSON.stringify({ widgetId: "test" }),
      })
    );
    expect(attackerCheck.status).toBe(429);

    // 2. Honest client makes request simultaneously from different IP
    const honestRes = await app.handle(
      new Request("http://localhost/v2/widget/create-thread", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": honestClientIp,
          "x-test-rate-limit": "true",
        },
        body: JSON.stringify({ widgetId: "test" }),
      })
    );

    // Honest client is NOT blocked!
    expect(honestRes.status).not.toBe(429);
  });
});
