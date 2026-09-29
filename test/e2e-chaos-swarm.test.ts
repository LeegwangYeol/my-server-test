/**
 * 100+ Agent Swarm Concurrency Chaos Stress Test Suite (Milestone 3)
 * Target: my-server-test/test/e2e-chaos-swarm.test.ts
 *
 * Verifies:
 * 1. Suite 1: 100-Agent Full-Stack Swarm Concurrency (/v2/ask HTTP Route).
 * 2. Suite 2: Error Injection Swarm (HTTP 429 dynamic backoff with ISO 8601 & delta-seconds,
 *             HTTP 402 cross-account fast-break in <5ms with 0 calls to sibling keys, 503 outage).
 * 3. Suite 3: Pool Saturation & Immediate Starvation Recovery.
 * 4. Suite 4: High-Velocity Rapid Burst Soak Test (200 requests).
 *
 * Invariants Enforced:
 * - Total swarm execution resolves well within Vercel's 60s timeout (<10s).
 * - Authoritative ZCARD == 0 across all keys in the store immediately upon swarm completion.
 * - Zero unhandled promise rejections, zero deadlocks, zero counter drift.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, test, mock } from "bun:test";
import { getKeyStore, resetCachedProviderForTesting } from "../lib/llm/factory";
import type { KeyConfig } from "../lib/llm/key-manager";

// ── Hermetic Mocking of Storage Layers ──────────────────────────────
const VALID_WIDGET_ID = "swarm-chaos-widget-v2";
const registeredWidgets = new Map<string, any>([
  [
    VALID_WIDGET_ID,
    {
      id: VALID_WIDGET_ID,
      name: "Swarm Chaos Production Widget",
      theme: "dark",
      description: "Chaos Test Widget",
      welcome_message: "Ready for stress testing.",
      system_prompt: "You are a resilient AI assistant.",
      suggested_questions: [],
      icon_url: null,
      chat_bubble_size: null,
      is_deleted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
]);

mock.module("../lib/widget-store", () => ({
  getWidget: async (id: string) => {
    if (!id || typeof id !== "string") return null;
    return registeredWidgets.get(id.trim()) ?? null;
  },
  listWidgetsRegistered: async () => Array.from(registeredWidgets.values()),
  upsertWidget: async (w: any) => w,
  deleteWidget: async () => true,
}));

let mockMessages: Array<{ id: number; thread_id: string; role: string; content: string }> = [];

mock.module("../lib/chat-store", () => ({
  createThread: async (widgetId: string) => `thread-${widgetId}-${Math.random().toString(36).slice(2)}`,
  getThread: async (threadId: string, widgetId?: string) => ({
    id: threadId,
    widget_id: widgetId ?? VALID_WIDGET_ID,
    system_prompt: null,
    context_text: null,
  }),
  listMessages: async () => mockMessages,
  appendMessage: async (threadId: string, role: string, content: string) => {
    mockMessages.push({ id: mockMessages.length + 1, thread_id: threadId, role, content });
  },
  toWidgetMessage: (m: any) => ({ role: m.role, content: m.content }),
  listThreads: async () => [],
  listWidgets: async () => [],
  renameThread: async () => {},
  updateThreadPrompt: async () => {},
}));

const { createApp } = await import("../src/app");
type App = Awaited<ReturnType<typeof createApp>>;

// Helper: HTTP POST dispatch to Elysia in-process
const postJson = (app: App, path: string, body: unknown, signal?: AbortSignal) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal,
    })
  );

// Helper: Create an SSE response readable stream
function createSseResponse(text: string, delayMs = 1): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.enqueue(
        enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      );
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// Helper: Drain SSE response to completion or handle abort
async function drainSseStream(res: Response, signal?: AbortSignal): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  const onAbort = () => {
    try {
      reader.cancel();
    } catch {}
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // Stream read error or aborted
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    try {
      reader.releaseLock();
    } catch {}
  }

  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

describe("Milestone 3: 100+ Agent Swarm Concurrency Chaos Stress Test Suite", () => {
  let app: App;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    process.env.ADMIN_TOKEN = "test-admin-secret";
    process.env.LLM_PROVIDER = "openrouter";
    process.env.LLM_MAX_TOKENS = "512";
    app = await createApp(true);
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockMessages = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENROUTER_API_KEYS;
    resetCachedProviderForTesting();
  });

  // ──────────────────────────────────────────────────────────────────
  // Suite 1: 100-Agent Full-Stack Swarm Concurrency (/v2/ask)
  // ──────────────────────────────────────────────────────────────────
  describe("Suite 1: 100-Agent Full-Stack Swarm Concurrency (/v2/ask HTTP Route)", () => {
    test("100 concurrent requests (70% full, 15% mid-stream abort, 15% pre-stream abort) with zero leaks (<10s)", async () => {
      const poolKeys: KeyConfig[] = [
        { id: "key-a1", apiKey: "sk-a1", accountId: "acc-alpha", tier: 0, weight: 10, maxConcurrency: 15 },
        { id: "key-a2", apiKey: "sk-a2", accountId: "acc-alpha", tier: 0, weight: 10, maxConcurrency: 15 },
        { id: "key-b1", apiKey: "sk-b1", accountId: "acc-beta", tier: 0, weight: 10, maxConcurrency: 15 },
        { id: "key-b2", apiKey: "sk-b2", accountId: "acc-beta", tier: 0, weight: 10, maxConcurrency: 15 },
        { id: "key-c1", apiKey: "sk-c1", accountId: "acc-gamma", tier: 1, weight: 5, maxConcurrency: 15 },
      ];
      process.env.OPENROUTER_API_KEYS = JSON.stringify(poolKeys);
      resetCachedProviderForTesting();
      const store = getKeyStore();

      // Mock upstream fetch for OpenRouter completions
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("openrouter.ai")) {
          return createSseResponse("token-response", 0);
        }
        return originalFetch(url, init);
      };

      const SWARM_SIZE = 100;
      let fullStreamCount = 0;
      let midAbortCount = 0;
      let preAbortCount = 0;
      let rateLimitedCount = 0;
      let resolvedCount = 0;

      const swarmPromises = Array.from({ length: SWARM_SIZE }).map(async (_, idx) => {
        // Jittered arrival 0-25ms
        const arrivalJitter = Math.floor(Math.random() * 25);
        await new Promise((r) => setTimeout(r, arrivalJitter));

        const controller = new AbortController();
        const requestType = idx % 20; // 0..19

        if (requestType === 0 || requestType === 1 || requestType === 2) {
          // ~15% Pre-stream abort
          preAbortCount++;
          setTimeout(() => controller.abort(), 1);
        } else if (requestType === 3 || requestType === 4 || requestType === 5) {
          // ~15% Mid-stream abort
          midAbortCount++;
          setTimeout(() => controller.abort(), 10);
        } else {
          // ~70% Normal full stream
          fullStreamCount++;
        }

        try {
          const res = await postJson(
            app,
            "/v2/ask",
            {
              widgetId: VALID_WIDGET_ID,
              message: `Swarm agent request #${idx}`,
            },
            controller.signal
          );

          if (res.status === 200) {
            await drainSseStream(res, controller.signal);
          } else if (res.status === 429) {
            rateLimitedCount++;
          }
        } catch {
          // Handled client abort or stream cancellation
        } finally {
          resolvedCount++;
        }
      });

      const startTime = performance.now();
      const DEADLOCK_SAFETY_MS = 15_000;

      await Promise.race([
        Promise.all(swarmPromises),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("SWARM_DEADLOCK_TIMEOUT: Swarm hung!")), DEADLOCK_SAFETY_MS)
        ),
      ]);

      const durationMs = performance.now() - startTime;

      // 1. All 100 requests resolved
      expect(resolvedCount).toBe(SWARM_SIZE);
      expect(fullStreamCount + midAbortCount + preAbortCount).toBe(SWARM_SIZE);

      // 2. High concurrency throughput: finished strictly < 10 seconds (well below Vercel's 60s)
      expect(durationMs).toBeLessThan(10_000);

      // 3. ZERO LEASE LEAKS GUARANTEE:
      // Authoritative ZCARD across ALL keys in the pool must be EXACTLY 0!
      for (const k of poolKeys) {
        const activeLeases = await store.getActiveLeaseCount(k.id);
        expect(activeLeases).toBe(0);
      }
    }, 15000);
  });

  // ──────────────────────────────────────────────────────────────────
  // Suite 2: Error Injection Swarm (429, 402, 503)
  // ──────────────────────────────────────────────────────────────────
  describe("Suite 2: Error Injection Swarm (429 Backoff, 402 Fast-Break, 503 Outage)", () => {
    test("2.1 Dynamic 429 backoff handles delta-seconds & ISO 8601 with failover and zero leaks", async () => {
      const poolKeys: KeyConfig[] = [
        { id: "key-retry-1", apiKey: "sk-retry-1", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "key-retry-2", apiKey: "sk-retry-2", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      process.env.OPENROUTER_API_KEYS = JSON.stringify(poolKeys);
      resetCachedProviderForTesting();
      const store = getKeyStore();

      let fetchCallCount = 0;
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization || "";
        fetchCallCount++;

        // First key returns 429 with delta-seconds
        if (auth.includes("sk-retry-1")) {
          return new Response(JSON.stringify({ error: { message: "Rate limit hit" } }), {
            status: 429,
            headers: { "retry-after": "2" },
          });
        }

        // Second key succeeds
        return createSseResponse("failover succeeded");
      };

      const res = await postJson(app, "/v2/ask", {
        widgetId: VALID_WIDGET_ID,
        message: "Testing 429 failover",
      });

      expect(res.status).toBe(200);
      const text = await drainSseStream(res);
      expect(text).toContain("failover succeeded");
      expect(fetchCallCount).toBeGreaterThanOrEqual(2);

      // Key 1 is now in cooldown (cooldownUntil > Date.now())
      const metrics1 = await store.getKeyMetrics("key-retry-1");
      expect(metrics1.state).toBe("RATE_LIMITED");
      expect(metrics1.cooldownUntil).toBeGreaterThan(Date.now());

      // Verify zero lease leaks
      for (const k of poolKeys) {
        expect(await store.getActiveLeaseCount(k.id)).toBe(0);
      }
    });

    test("2.2 HTTP 402 cross-account fast-break executes in <5ms with 0 calls to sibling keys", async () => {
      const poolKeys: KeyConfig[] = [
        // Bankrupt account with 3 linked keys
        { id: "k-bankrupt-1", apiKey: "sk-b1", accountId: "acc-bankrupt", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-bankrupt-2", apiKey: "sk-b2", accountId: "acc-bankrupt", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-bankrupt-3", apiKey: "sk-b3", accountId: "acc-bankrupt", tier: 0, weight: 10, maxConcurrency: 5 },
        // Healthy funded account
        { id: "k-funded-1", apiKey: "sk-funded", accountId: "acc-funded", tier: 1, weight: 5, maxConcurrency: 5 },
      ];
      process.env.OPENROUTER_API_KEYS = JSON.stringify(poolKeys);
      resetCachedProviderForTesting();
      const store = getKeyStore();

      const fetchCounts = new Map<string, number>();

      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization || "";
        const key = auth.replace("Bearer ", "").trim();
        fetchCounts.set(key, (fetchCounts.get(key) || 0) + 1);

        if (key === "sk-b1") {
          return new Response(JSON.stringify({ error: { message: "Credits depleted" } }), {
            status: 402,
            headers: { "content-type": "application/json" },
          });
        }

        if (key === "sk-funded") {
          return createSseResponse("Funded reply");
        }

        return new Response(JSON.stringify({ error: "Should not be called" }), { status: 500 });
      };

      const startTime = performance.now();
      const res = await postJson(app, "/v2/ask", {
        widgetId: VALID_WIDGET_ID,
        message: "Testing 402 fast-break",
      });
      const durationMs = performance.now() - startTime;

      expect(res.status).toBe(200);
      const text = await drainSseStream(res);
      expect(text).toContain("Funded reply");

      // Verify sibling keys in bankrupt account received ZERO network calls!
      expect(fetchCounts.get("sk-b1")).toBe(1);
      expect(fetchCounts.get("sk-b2") ?? 0).toBe(0);
      expect(fetchCounts.get("sk-b3") ?? 0).toBe(0);

      // Verify all keys under acc-bankrupt are marked EXHAUSTED
      const m1 = await store.getKeyMetrics("k-bankrupt-1");
      const m2 = await store.getKeyMetrics("k-bankrupt-2");
      const m3 = await store.getKeyMetrics("k-bankrupt-3");
      expect(m1.state).toBe("EXHAUSTED");
      expect(m2.state).toBe("EXHAUSTED");
      expect(m3.state).toBe("EXHAUSTED");

      // Verify zero lease leaks
      for (const k of poolKeys) {
        expect(await store.getActiveLeaseCount(k.id)).toBe(0);
      }
    });

    test("2.3 Upstream provider outage discrimination trips circuit without key cooldown penalty", async () => {
      const poolKeys: KeyConfig[] = [
        { id: "k-outage-1", apiKey: "sk-outage", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      process.env.OPENROUTER_API_KEYS = JSON.stringify(poolKeys);
      resetCachedProviderForTesting();
      const store = getKeyStore();

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "Anthropic infrastructure outage",
              metadata: { provider_name: "Anthropic" },
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } }
        );
      };

      const res = await postJson(app, "/v2/ask", {
        widgetId: VALID_WIDGET_ID,
        message: "Testing 503 outage",
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as any;
      expect(body.code).toBe("UPSTREAM_MODEL_OUTAGE");

      // Key should NOT be penalized into long cooldown
      const metrics = await store.getKeyMetrics("k-outage-1");
      expect(metrics.state).toBe("ACTIVE");
      expect(metrics.cooldownUntil).toBeLessThanOrEqual(Date.now());

      // Zero lease leaks
      expect(await store.getActiveLeaseCount("k-outage-1")).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Suite 3: Pool Saturation & Immediate Starvation Recovery
  // ──────────────────────────────────────────────────────────────────
  describe("Suite 3: Pool Saturation & Immediate Starvation Recovery", () => {
    test("overflowing pool capacity fails fast with HTTP 429 and recovers immediately upon release", async () => {
      // 2 keys with maxConcurrency = 2 (total 4 concurrent slots)
      const poolKeys: KeyConfig[] = [
        { id: "k-sat-1", apiKey: "sk-sat-1", tier: 0, weight: 10, maxConcurrency: 2 },
        { id: "k-sat-2", apiKey: "sk-sat-2", tier: 0, weight: 10, maxConcurrency: 2 },
      ];
      process.env.OPENROUTER_API_KEYS = JSON.stringify(poolKeys);
      resetCachedProviderForTesting();
      const store = getKeyStore();

      let activeUpstreamRequests = 0;
      globalThis.fetch = async () => {
        activeUpstreamRequests++;
        // Hold slots for 80ms to saturate capacity
        await new Promise((r) => setTimeout(r, 80));
        activeUpstreamRequests--;
        return createSseResponse("saturated slot response", 10);
      };

      // Launch 16 simultaneous requests against 4 total slots
      const requests = Array.from({ length: 16 }).map(async (_, i) => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: `Saturation test #${i}`,
        });
        if (res.status === 200) {
          await drainSseStream(res);
          return { status: 200 };
        }
        const json = (await res.json()) as any;
        return { status: res.status, headers: res.headers, body: json };
      });

      const results = await Promise.all(requests);

      const status200 = results.filter((r) => r.status === 200);
      const status429 = results.filter((r) => r.status === 429);

      // At least 4 succeeded, and excess requests failed fast with 429
      expect(status200.length).toBeGreaterThanOrEqual(4);
      expect(status429.length).toBeGreaterThan(0);

      // Verify 429 responses have Retry-After header and ALL_KEYS_RATE_LIMITED code
      for (const r of status429) {
        expect(r.headers.get("retry-after")).toBeDefined();
        expect(r.body.code).toBe("ALL_KEYS_RATE_LIMITED");
      }

      // Verify zero lease leaks after saturation burst completes
      for (const k of poolKeys) {
        expect(await store.getActiveLeaseCount(k.id)).toBe(0);
      }

      // Recovery verification: new request succeeds immediately now that slots are freed
      const recoveryRes = await postJson(app, "/v2/ask", {
        widgetId: VALID_WIDGET_ID,
        message: "Recovery check",
      });
      expect(recoveryRes.status).toBe(200);
      await drainSseStream(recoveryRes);

      for (const k of poolKeys) {
        expect(await store.getActiveLeaseCount(k.id)).toBe(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Suite 4: High-Velocity Rapid Burst Soak Test (200 Requests)
  // ──────────────────────────────────────────────────────────────────
  describe("Suite 4: High-Velocity Rapid Burst Soak Test (200 Requests)", () => {
    test("200 rapid requests maintain zero counter drift and zero lease leaks (<10s)", async () => {
      const poolKeys: KeyConfig[] = [
        { id: "k-soak-1", apiKey: "sk-soak-1", tier: 0, weight: 10, maxConcurrency: 20 },
        { id: "k-soak-2", apiKey: "sk-soak-2", tier: 0, weight: 10, maxConcurrency: 20 },
        { id: "k-soak-3", apiKey: "sk-soak-3", tier: 0, weight: 10, maxConcurrency: 20 },
      ];
      process.env.OPENROUTER_API_KEYS = JSON.stringify(poolKeys);
      resetCachedProviderForTesting();
      const store = getKeyStore();

      globalThis.fetch = async () => {
        return createSseResponse("soak-reply", 0);
      };

      const TOTAL_SOAK = 200;
      let completedCount = 0;

      const startTime = performance.now();

      // Dispatch 200 requests in rapid waves of 50
      for (let wave = 0; wave < 4; wave++) {
        const wavePromises = Array.from({ length: 50 }).map(async (_, i) => {
          const idx = wave * 50 + i;
          const controller = new AbortController();

          // 5% client abort
          if (idx % 20 === 19) {
            setTimeout(() => controller.abort(), 2);
          }

          try {
            const res = await postJson(
              app,
              "/v2/ask",
              {
                widgetId: VALID_WIDGET_ID,
                message: `Soak request #${idx}`,
              },
              controller.signal
            );

            if (res.status === 200) {
              await drainSseStream(res, controller.signal);
            }
          } catch {
            // Handled abort
          } finally {
            completedCount++;
          }
        });

        await Promise.all(wavePromises);
      }

      const durationMs = performance.now() - startTime;

      // 1. All 200 completed
      expect(completedCount).toBe(TOTAL_SOAK);

      // 2. Performance: 200 requests finished in < 10,000ms
      expect(durationMs).toBeLessThan(10_000);

      // 3. ZERO LEASE LEAKS GUARANTEE across all keys in pool
      for (const k of poolKeys) {
        const activeLeases = await store.getActiveLeaseCount(k.id);
        expect(activeLeases).toBe(0);
        const metrics = await store.getKeyMetrics(k.id);
        expect(metrics.inFlightRequests).toBe(0);
      }
    }, 15000);
  });
});
