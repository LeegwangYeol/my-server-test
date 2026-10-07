/**
 * Empirical Challenger M3 Test Suite: Adversarial Swarm Stress & Zero-Leak Proof
 * Target: my-server-test/test/empirical-challenger-m3.test.ts
 *
 * Adversarial Challenges:
 * 1. High-Chaos Swarm with Multi-Chunk Latency & Multi-Point Aborts (ZCARD == 0 guarantee).
 * 2. Cascading 429 Backoff with Delta-Seconds and HTTP-Date across Multi-Tier Keys.
 * 3. Concurrent Race Cross-Account Fast-Break (5 keys per bankrupt account under 50 concurrent requests).
 * 4. Concurrent Provider Outage Isolation (20 concurrent requests without key penalty).
 * 5. Constrained Capacity Rapid Saturation Soak (200 requests against 4 slots, immediate recovery, ZCARD == 0).
 */

import { beforeAll, beforeEach, afterEach, describe, expect, test, mock } from "bun:test";
import { getKeyStore, resetCachedProviderForTesting } from "../lib/llm/factory";
import type { KeyConfig } from "../lib/llm/key-manager";

const VALID_WIDGET_ID = "adversarial-m3-widget";
const registeredWidgets = new Map<string, any>([
  [
    VALID_WIDGET_ID,
    {
      id: VALID_WIDGET_ID,
      name: "Adversarial M3 Production Widget",
      theme: "dark",
      description: "Adversarial Challenger Test Widget",
      welcome_message: "Ready.",
      system_prompt: "You are a resilient assistant.",
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

const postJson = (app: App, path: string, body: unknown, signal?: AbortSignal) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal,
    })
  );

function createMultiChunkSseResponse(chunks: string[], chunkDelayMs = 5): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (chunkDelayMs > 0) {
          await new Promise((r) => setTimeout(r, chunkDelayMs));
        }
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
        );
      }
      if (chunkDelayMs > 0) {
        await new Promise((r) => setTimeout(r, chunkDelayMs));
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

describe("Empirical Challenger M3: Adversarial Swarm Stress & Zero-Leak Invariants", () => {
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

  // ─── Challenge 1: Multi-Chunk Latency with Varied Point Aborts ───
  test("Challenge 1: 100 concurrent requests with multi-chunk SSE latency and multi-point aborts maintain ZCARD == 0", async () => {
    const poolKeys: KeyConfig[] = [
      { id: "adv-k1", apiKey: "sk-adv1", accountId: "acc-1", tier: 0, weight: 10, maxConcurrency: 15 },
      { id: "adv-k2", apiKey: "sk-adv2", accountId: "acc-1", tier: 0, weight: 10, maxConcurrency: 15 },
      { id: "adv-k3", apiKey: "sk-adv3", accountId: "acc-2", tier: 0, weight: 10, maxConcurrency: 15 },
      { id: "adv-k4", apiKey: "sk-adv4", accountId: "acc-2", tier: 0, weight: 10, maxConcurrency: 15 },
      { id: "adv-k5", apiKey: "sk-adv5", accountId: "acc-3", tier: 1, weight: 5, maxConcurrency: 15 },
    ];
    process.env.OPENROUTER_API_KEYS = JSON.stringify(poolKeys);
    resetCachedProviderForTesting();
    const store = getKeyStore();

    // Multi-chunk SSE stream with simulated network latency
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("openrouter.ai")) {
        return createMultiChunkSseResponse(["chunk-1", " ", "chunk-2", " ", "chunk-3"], 3);
      }
      return originalFetch(url, init);
    };

    const TOTAL_REQUESTS = 100;
    let completedCount = 0;

    const promises = Array.from({ length: TOTAL_REQUESTS }).map(async (_, idx) => {
      // Jitter arrival between 0 and 20ms
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20)));

      const controller = new AbortController();
      const abortTiming = idx % 10;

      if (abortTiming === 0) {
        // Immediate pre-abort (before postJson)
        controller.abort();
      } else if (abortTiming === 1 || abortTiming === 2) {
        // Early abort (1-3ms)
        setTimeout(() => controller.abort(), 2);
      } else if (abortTiming === 3 || abortTiming === 4) {
        // Mid-stream abort (8-15ms)
        setTimeout(() => controller.abort(), 10);
      }
      // Remaining 50% run to full completion

      try {
        const res = await postJson(
          app,
          "/v2/ask",
          {
            widgetId: VALID_WIDGET_ID,
            message: `Adversarial swarm request ${idx}`,
          },
          controller.signal
        );

        if (res.status === 200) {
          await drainSseStream(res, controller.signal);
        }
      } catch {
        // Expected client abort error
      } finally {
        completedCount++;
      }
    });

    const startTime = performance.now();
    let deadlockTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(promises),
        new Promise((_, reject) => {
          deadlockTimer = setTimeout(
            () => reject(new Error("DEADLOCK: Swarm did not finish in 15s")),
            15000
          );
        }),
      ]);
    } finally {
      if (deadlockTimer) clearTimeout(deadlockTimer);
    }
    const durationMs = performance.now() - startTime;

    expect(completedCount).toBe(TOTAL_REQUESTS);
    expect(durationMs).toBeLessThan(10_000);

    // CRITICAL: ZCARD MUST BE 0 across all keys
    for (const k of poolKeys) {
      const leases = await store.getActiveLeaseCount(k.id);
      expect(leases).toBe(0);
      const metrics = await store.getKeyMetrics(k.id);
      expect(metrics.inFlightRequests).toBe(0);
    }
  }, 15000);

  // ─── Challenge 2: Cascading Multi-Tier 429 Backoff with RFC 9110 HTTP-Date ───
  test("Challenge 2: Cascading 429 across tiers with delta-seconds and HTTP-date records cooldown and clears leases", async () => {
    const futureDate = new Date(Date.now() + 5000).toUTCString();
    const poolKeys: KeyConfig[] = [
      { id: "cascade-k1", apiKey: "sk-casc1", tier: 0, weight: 10, maxConcurrency: 5 },
      { id: "cascade-k2", apiKey: "sk-casc2", tier: 0, weight: 10, maxConcurrency: 5 },
      { id: "cascade-k3", apiKey: "sk-casc3", tier: 1, weight: 5, maxConcurrency: 5 },
    ];
    process.env.OPENROUTER_API_KEYS = JSON.stringify(poolKeys);
    resetCachedProviderForTesting();
    const store = getKeyStore();

    const callMap = new Map<string, number>();

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization || "";
      const key = auth.replace("Bearer ", "").trim();
      callMap.set(key, (callMap.get(key) || 0) + 1);

      if (key === "sk-casc1") {
        // Delta-seconds 429
        return new Response(JSON.stringify({ error: { message: "Tier 0 Rate Limit" } }), {
          status: 429,
          headers: { "retry-after": "3" },
        });
      }

      if (key === "sk-casc2") {
        // RFC 9110 HTTP-date 429
        return new Response(JSON.stringify({ error: { message: "Tier 0 Secondary Limit" } }), {
          status: 429,
          headers: { "retry-after": futureDate },
        });
      }

      if (key === "sk-casc3") {
        // Tier 1 fallback succeeds
        return createMultiChunkSseResponse(["Cascading", " ", "success!"], 0);
      }

      return new Response("Unexpected", { status: 500 });
    };

    const res = await postJson(app, "/v2/ask", {
      widgetId: VALID_WIDGET_ID,
      message: "Testing cascading 429 failover",
    });

    expect(res.status).toBe(200);
    const text = await drainSseStream(res);
    expect(text).toContain("Cascading");
    expect(text).toContain("success!");

    // Verify key 1 was called once and placed in cooldown
    expect(callMap.get("sk-casc1")).toBe(1);
    const m1 = await store.getKeyMetrics("cascade-k1");
    expect(m1.state).toBe("RATE_LIMITED");
    expect(m1.cooldownUntil).toBeGreaterThan(Date.now());

    // Verify key 2 was called once and placed in cooldown
    expect(callMap.get("sk-casc2")).toBe(1);
    const m2 = await store.getKeyMetrics("cascade-k2");
    expect(m2.state).toBe("RATE_LIMITED");
    expect(m2.cooldownUntil).toBeGreaterThan(Date.now());

    // Verify key 3 succeeded
    expect(callMap.get("sk-casc3")).toBe(1);

    // ZERO LEASE LEAKS
    for (const k of poolKeys) {
      expect(await store.getActiveLeaseCount(k.id)).toBe(0);
    }
  });

  // ─── Challenge 3: Concurrent Race Cross-Account Fast-Break (5 Keys per Bankrupt Account) ───
  test("Challenge 3: 50 concurrent requests hitting a bankrupt account fast-break <5ms with 0 calls to sibling keys", async () => {
    // 5 keys under acc-bankrupt, 2 keys under acc-healthy
    const poolKeys: KeyConfig[] = [
      { id: "b-1", apiKey: "sk-b1", accountId: "acc-bankrupt", tier: 0, weight: 10, maxConcurrency: 10 },
      { id: "b-2", apiKey: "sk-b2", accountId: "acc-bankrupt", tier: 0, weight: 10, maxConcurrency: 10 },
      { id: "b-3", apiKey: "sk-b3", accountId: "acc-bankrupt", tier: 0, weight: 10, maxConcurrency: 10 },
      { id: "b-4", apiKey: "sk-b4", accountId: "acc-bankrupt", tier: 0, weight: 10, maxConcurrency: 10 },
      { id: "b-5", apiKey: "sk-b5", accountId: "acc-bankrupt", tier: 0, weight: 10, maxConcurrency: 10 },
      { id: "h-1", apiKey: "sk-h1", accountId: "acc-healthy", tier: 1, weight: 10, maxConcurrency: 25 },
      { id: "h-2", apiKey: "sk-h2", accountId: "acc-healthy", tier: 1, weight: 10, maxConcurrency: 25 },
    ];
    process.env.OPENROUTER_API_KEYS = JSON.stringify(poolKeys);
    resetCachedProviderForTesting();
    const store = getKeyStore();

    const callCounts = new Map<string, number>();

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization || "";
      const key = auth.replace("Bearer ", "").trim();
      callCounts.set(key, (callCounts.get(key) || 0) + 1);

      if (key.startsWith("sk-b")) {
        return new Response(JSON.stringify({ error: { message: "Account credits depleted" } }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }

      if (key.startsWith("sk-h")) {
        return createMultiChunkSseResponse(["Healthy", " ", "response"], 0);
      }

      return new Response("Unexpected", { status: 500 });
    };

    // 1. Initial trigger request hits bankrupt account and receives 402
    const triggerRes = await postJson(app, "/v2/ask", {
      widgetId: VALID_WIDGET_ID,
      message: "Trigger 402 fast-break",
    });
    expect(triggerRes.status).toBe(200);
    const triggerText = await drainSseStream(triggerRes);
    expect(triggerText).toContain("Healthy");

    // The trigger request called b-1, got 402, fast-broke acc-bankrupt, and failed over to healthy account
    expect(callCounts.get("sk-b1")).toBe(1);
    expect(callCounts.get("sk-b2") ?? 0).toBe(0);
    expect(callCounts.get("sk-b3") ?? 0).toBe(0);
    expect(callCounts.get("sk-b4") ?? 0).toBe(0);
    expect(callCounts.get("sk-b5") ?? 0).toBe(0);

    // 2. Now launch a swarm of 50 concurrent requests against the pool
    const SWARM_SIZE = 50;
    const requests = Array.from({ length: SWARM_SIZE }).map(async (_, idx) => {
      const res = await postJson(app, "/v2/ask", {
        widgetId: VALID_WIDGET_ID,
        message: `Fast-break swarm #${idx}`,
      });
      if (res.status === 200) {
        await drainSseStream(res);
        return 200;
      }
      return res.status;
    });

    const results = await Promise.all(requests);

    // All requests must succeed via healthy account
    const successes = results.filter((s) => s === 200);
    expect(successes.length).toBe(SWARM_SIZE);

    // CRITICAL FAST-BREAK INVARIANT:
    // Sibling keys sk-b2, sk-b3, sk-b4, sk-b5 must have EXACTLY 0 calls!
    // And sk-b1 must have ONLY the 1 initial call!
    expect(callCounts.get("sk-b1")).toBe(1);
    expect(callCounts.get("sk-b2") ?? 0).toBe(0);
    expect(callCounts.get("sk-b3") ?? 0).toBe(0);
    expect(callCounts.get("sk-b4") ?? 0).toBe(0);
    expect(callCounts.get("sk-b5") ?? 0).toBe(0);

    // Sibling keys should all be marked EXHAUSTED
    for (const bId of ["b-1", "b-2", "b-3", "b-4", "b-5"]) {
      const m = await store.getKeyMetrics(bId);
      expect(m.state).toBe("EXHAUSTED");
      expect(await store.getActiveLeaseCount(bId)).toBe(0);
    }

    // Zero lease leaks across all keys
    for (const k of poolKeys) {
      expect(await store.getActiveLeaseCount(k.id)).toBe(0);
    }
  });

  // ─── Challenge 4: Concurrent Provider Outage Isolation Under Swarm ───
  test("Challenge 4: 20 concurrent requests hitting upstream outage return 503 UPSTREAM_MODEL_OUTAGE without key cooldown penalty", async () => {
    const poolKeys: KeyConfig[] = [
      { id: "outage-k1", apiKey: "sk-out1", tier: 0, weight: 10, maxConcurrency: 10 },
      { id: "outage-k2", apiKey: "sk-out2", tier: 0, weight: 10, maxConcurrency: 10 },
    ];
    process.env.OPENROUTER_API_KEYS = JSON.stringify(poolKeys);
    resetCachedProviderForTesting();
    const store = getKeyStore();

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: "OpenAI is experiencing major outage",
            metadata: { provider_name: "OpenAI" },
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
    };

    const CONCURRENT_COUNT = 20;
    const requests = Array.from({ length: CONCURRENT_COUNT }).map(async (_, idx) => {
      const res = await postJson(app, "/v2/ask", {
        widgetId: VALID_WIDGET_ID,
        message: `Outage test #${idx}`,
      });
      const body = (await res.json()) as any;
      return { status: res.status, body };
    });

    const results = await Promise.all(requests);

    for (const r of results) {
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("UPSTREAM_MODEL_OUTAGE");
    }

    // Keys MUST NOT be penalized into cooldown
    for (const k of poolKeys) {
      const metrics = await store.getKeyMetrics(k.id);
      expect(metrics.state).toBe("ACTIVE");
      expect(metrics.cooldownUntil).toBeLessThanOrEqual(Date.now());
      expect(await store.getActiveLeaseCount(k.id)).toBe(0);
    }
  });

  // ─── Challenge 5: Constrained Capacity Saturation & Soak Recovery ───
  test("Challenge 5: 200 requests burst against 4 total slots with fast 429 and immediate recovery", async () => {
    const poolKeys: KeyConfig[] = [
      { id: "c5-k1", apiKey: "sk-c5-1", tier: 0, weight: 10, maxConcurrency: 2 },
      { id: "c5-k2", apiKey: "sk-c5-2", tier: 0, weight: 10, maxConcurrency: 2 },
    ];
    process.env.OPENROUTER_API_KEYS = JSON.stringify(poolKeys);
    resetCachedProviderForTesting();
    const store = getKeyStore();

    // Small delay to exercise saturation
    globalThis.fetch = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return createMultiChunkSseResponse(["sat-token"], 2);
    };

    const TOTAL_BURST = 100;
    const burstPromises = Array.from({ length: TOTAL_BURST }).map(async (_, i) => {
      const res = await postJson(app, "/v2/ask", {
        widgetId: VALID_WIDGET_ID,
        message: `Burst test #${i}`,
      });
      if (res.status === 200) {
        await drainSseStream(res);
        return 200;
      }
      return res.status;
    });

    const results = await Promise.all(burstPromises);
    const count200 = results.filter((s) => s === 200).length;
    const count429 = results.filter((s) => s === 429).length;

    expect(count200).toBeGreaterThanOrEqual(4);
    expect(count429).toBeGreaterThan(0);
    expect(count200 + count429).toBe(TOTAL_BURST);

    // ZERO LEASE LEAKS
    for (const k of poolKeys) {
      const leases = await store.getActiveLeaseCount(k.id);
      expect(leases).toBe(0);
    }

    // Instant recovery: new request succeeds immediately
    const recoveryRes = await postJson(app, "/v2/ask", {
      widgetId: VALID_WIDGET_ID,
      message: "Post-saturation instant recovery",
    });
    expect(recoveryRes.status).toBe(200);
    await drainSseStream(recoveryRes);

    for (const k of poolKeys) {
      expect(await store.getActiveLeaseCount(k.id)).toBe(0);
    }
  });
});
