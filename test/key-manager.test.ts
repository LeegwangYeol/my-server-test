import { describe, expect, test, beforeEach } from "bun:test";
import {
  MemoryKeyStore,
  UpstashRedisKeyStore,
  WLIFSelectionEngine,
  HealthAndCooldownEngine,
  CanaryGraduationStateMachine,
  executeWithResilientFailover,
  AllKeysRateLimitedError,
  AllAccountsExhaustedError,
  UpstreamProviderOutageError,
  FailoverExhaustedError,
  RotatingLLMProvider,
  type KeyConfig,
  type KeyCandidate,
  type KeyRuntimeState,
} from "../lib/llm/key-manager";

describe("Milestone 1: Backend Concurrency & Key Rotation Engine", () => {
  // ─── 1. ZSET Self-Pruning & Live Cardinality via ZCARD ───────────────────
  describe("ZSET Concurrency Semaphores & Self-Pruning", () => {
    test("atomically prunes expired leases on reservation and reports accurate live ZCARD", async () => {
      let currentTime = 100_000;
      const store = new MemoryKeyStore({
        clock: () => currentTime,
        leaseTimeoutMs: 10_000,
      });

      const keys: KeyConfig[] = [
        {
          id: "key-1",
          apiKey: "sk-or-test-1",
          tier: 0,
          weight: 10,
          maxConcurrency: 5,
        },
      ];
      await store.syncKeys(keys);

      // Reserve 3 leases
      const res1 = await store.reserveKey();
      const res2 = await store.reserveKey();
      const res3 = await store.reserveKey();

      expect(res1).not.toBeNull();
      expect(res2).not.toBeNull();
      expect(res3).not.toBeNull();
      expect(await store.getActiveLeaseCount("key-1")).toBe(3);

      // Advance time by 15s (past the 10s lease timeout for all 3 leases)
      currentTime += 15_000;

      // Reserving a new lease must self-prune the 3 expired leases
      const res4 = await store.reserveKey();
      expect(res4).not.toBeNull();
      expect(res4?.keyId).toBe("key-1");

      // Live cardinality via ZCARD should now be exactly 1 (only res4 is active)
      const count = await store.getActiveLeaseCount("key-1");
      expect(count).toBe(1);

      // Release res4 cleanly
      await store.releaseKey("key-1", res4!.leaseToken, 200);
      expect(await store.getActiveLeaseCount("key-1")).toBe(0);
    });

    test("idempotent releaseKey does not corrupt lease counter or double-release", async () => {
      const store = new MemoryKeyStore();
      await store.syncKeys([
        { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
      ]);

      const res = await store.reserveKey();
      expect(res).not.toBeNull();
      expect(await store.getActiveLeaseCount("key-1")).toBe(1);

      // First release
      await store.releaseKey("key-1", res!.leaseToken, 200);
      expect(await store.getActiveLeaseCount("key-1")).toBe(0);

      // Second release with same token (idempotent, must not go negative)
      await store.releaseKey("key-1", res!.leaseToken, 200);
      expect(await store.getActiveLeaseCount("key-1")).toBe(0);
    });
  });

  // ─── 2. WLIF-THALIC Selection Algorithm ──────────────────────────────────
  describe("WLIF-THALIC Selection Engine", () => {
    test("prioritizes lower priority tier (Tier 0 over Tier 1) regardless of in-flight load", () => {
      const candidates: KeyCandidate[] = [
        {
          config: { id: "k-tier1", apiKey: "sk-t1", tier: 1, weight: 10, maxConcurrency: 5 },
          state: {
            id: "k-tier1",
            status: "ACTIVE",
            circuitState: "CLOSED",
            inFlightRequests: 0,
            consecutiveFailures: 0,
            consecutive429s: 0,
            cooldownUntil: 0,
            lastUsedAt: 100,
            healthScore: 1.0,
            lastStatusCode: null,
            lastErrorMessage: null,
            totalRequests: 0,
          },
          inFlight: 0,
        },
        {
          config: { id: "k-tier0", apiKey: "sk-t0", tier: 0, weight: 10, maxConcurrency: 5 },
          state: {
            id: "k-tier0",
            status: "ACTIVE",
            circuitState: "CLOSED",
            inFlightRequests: 2,
            consecutiveFailures: 0,
            consecutive429s: 0,
            cooldownUntil: 0,
            lastUsedAt: 200,
            healthScore: 1.0,
            lastStatusCode: null,
            lastErrorMessage: null,
            totalRequests: 2,
          },
          inFlight: 2,
        },
      ];

      const result = WLIFSelectionEngine.selectOptimalKey(candidates);
      expect(result).not.toBeNull();
      expect(result?.selectedKeyId).toBe("k-tier0");
      expect(result?.tier).toBe(0);
    });

    test("balances heterogeneous quotas via integer-scaled load score (inFlight / weight)", () => {
      // Key A: 200 RPM quota (weight 10), currently 2 in-flight -> load score = (2 * 1000) / 10 = 200
      // Key B: 50 RPM quota (weight 3), currently 1 in-flight -> load score = (1 * 1000) / 3 = 333
      // Key A has lower normalized load score (200 < 333) and should be chosen!
      const candidates: KeyCandidate[] = [
        {
          config: { id: "key-a-200rpm", apiKey: "sk-a", tier: 0, weight: 10, maxConcurrency: 10 },
          state: {
            id: "key-a-200rpm",
            status: "ACTIVE",
            circuitState: "CLOSED",
            inFlightRequests: 2,
            consecutiveFailures: 0,
            consecutive429s: 0,
            cooldownUntil: 0,
            lastUsedAt: 100,
            healthScore: 1.0,
            lastStatusCode: null,
            lastErrorMessage: null,
            totalRequests: 5,
          },
          inFlight: 2,
        },
        {
          config: { id: "key-b-50rpm", apiKey: "sk-b", tier: 0, weight: 3, maxConcurrency: 5 },
          state: {
            id: "key-b-50rpm",
            status: "ACTIVE",
            circuitState: "CLOSED",
            inFlightRequests: 1,
            consecutiveFailures: 0,
            consecutive429s: 0,
            cooldownUntil: 0,
            lastUsedAt: 100,
            healthScore: 1.0,
            lastStatusCode: null,
            lastErrorMessage: null,
            totalRequests: 3,
          },
          inFlight: 1,
        },
      ];

      const result = WLIFSelectionEngine.selectOptimalKey(candidates);
      expect(result).not.toBeNull();
      expect(result?.selectedKeyId).toBe("key-a-200rpm");
      expect(result?.loadScore).toBe(200);
    });

    test("enforces strict canary lock in WARMUP state (inFlight == 0 only)", () => {
      const candidates: KeyCandidate[] = [
        {
          config: { id: "canary-key", apiKey: "sk-c", tier: 0, weight: 10, maxConcurrency: 5 },
          state: {
            id: "canary-key",
            status: "WARMUP",
            circuitState: "CLOSED",
            inFlightRequests: 1, // Already has 1 canary in flight!
            consecutiveFailures: 0,
            consecutive429s: 1,
            cooldownUntil: 0,
            lastUsedAt: 100,
            healthScore: 0.5,
            lastStatusCode: 429,
            lastErrorMessage: "rate limited",
            totalRequests: 10,
          },
          inFlight: 1,
        },
      ];

      // With 1 in flight, WARMUP key is strictly locked
      expect(WLIFSelectionEngine.selectOptimalKey(candidates)).toBeNull();

      // With 0 in flight, WARMUP key is eligible as canary
      candidates[0].inFlight = 0;
      const res = WLIFSelectionEngine.selectOptimalKey(candidates);
      expect(res).not.toBeNull();
      expect(res?.selectedKeyId).toBe("canary-key");
      expect(res?.isCanary).toBe(true);
    });

    test("strictly respects excludeKeyIds to eliminate self-inflicted retry loops", () => {
      const candidates: KeyCandidate[] = [
        {
          config: { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
          state: {
            id: "key-1",
            status: "ACTIVE",
            circuitState: "CLOSED",
            inFlightRequests: 0,
            consecutiveFailures: 0,
            consecutive429s: 0,
            cooldownUntil: 0,
            lastUsedAt: 100,
            healthScore: 1.0,
            lastStatusCode: null,
            lastErrorMessage: null,
            totalRequests: 0,
          },
          inFlight: 0,
        },
        {
          config: { id: "key-2", apiKey: "sk-2", tier: 0, weight: 10, maxConcurrency: 5 },
          state: {
            id: "key-2",
            status: "ACTIVE",
            circuitState: "CLOSED",
            inFlightRequests: 0,
            consecutiveFailures: 0,
            consecutive429s: 0,
            cooldownUntil: 0,
            lastUsedAt: 100,
            healthScore: 1.0,
            lastStatusCode: null,
            lastErrorMessage: null,
            totalRequests: 0,
          },
          inFlight: 0,
        },
      ];

      const res = WLIFSelectionEngine.selectOptimalKey(candidates, ["key-1"]);
      expect(res).not.toBeNull();
      expect(res?.selectedKeyId).toBe("key-2");
    });
  });

  // ─── 3. Two-Phase Canary Handshake Graduation ─────────────────────────────
  describe("Two-Phase Canary Handshake Decoupling", () => {
    test("graduates WARMUP key to ACTIVE upon acknowledgeHandshake in <500ms", async () => {
      let currentTime = 100_000;
      const store = new MemoryKeyStore({ clock: () => currentTime });
      await store.syncKeys([
        { id: "canary-key", apiKey: "sk-canary", tier: 0, weight: 10, maxConcurrency: 5 },
      ]);

      // Put key into RATE_LIMITED with cooldown of 5s
      await store.releaseKey("canary-key", "dummy-token", 429, 5000, "rate limited");
      let metrics = await store.getKeyMetrics("canary-key");
      expect(metrics.state).toBe("RATE_LIMITED");

      // Advance clock past cooldown
      currentTime += 6000;

      // Reserving key promotes it to WARMUP as canary
      const res = await store.reserveKey();
      expect(res).not.toBeNull();
      metrics = await store.getKeyMetrics("canary-key");
      expect(metrics.state).toBe("WARMUP");

      // While in WARMUP with 1 in-flight, a second reservation must return null (strict lock)
      const blockedRes = await store.reserveKey();
      expect(blockedRes).toBeNull();

      // Phase 1: On HTTP 200 headers, acknowledgeHandshake executes
      const graduated = await store.acknowledgeHandshake("canary-key", res!.leaseToken);
      expect(graduated).toBe(true);

      // Key is now ACTIVE!
      metrics = await store.getKeyMetrics("canary-key");
      expect(metrics.state).toBe("ACTIVE");
      expect(metrics.consecutive429s).toBe(0);

      // Now other requests can reserve the key up to maxConcurrency while the first stream continues
      const nextRes = await store.reserveKey();
      expect(nextRes).not.toBeNull();
      expect(nextRes?.keyId).toBe("canary-key");

      // Phase 2: First stream finishes and releases its lease
      await store.releaseKey("canary-key", res!.leaseToken, 200);
      expect(await store.getActiveLeaseCount("canary-key")).toBe(1);

      // Second stream finishes
      await store.releaseKey("canary-key", nextRes!.leaseToken, 200);
      expect(await store.getActiveLeaseCount("canary-key")).toBe(0);
    });
  });

  // ─── 4. Defensive RFC 9110 Cooldown Math ─────────────────────────────────
  describe("Defensive RFC 9110 Cooldown Math", () => {
    test("handles delta-seconds header with positive jitter", () => {
      const headers = new Headers({ "retry-after": "5" });
      const cooldown = HealthAndCooldownEngine.calculate429Cooldown(headers, 1);
      // 5s + jitter (500-1500ms) = 5500 - 6500ms
      expect(cooldown).toBeGreaterThanOrEqual(5500);
      expect(cooldown).toBeLessThanOrEqual(6500);
      expect(Number.isNaN(cooldown)).toBe(false);
    });

    test("handles RFC 9110 HTTP-Date with server clock skew compensation", () => {
      const now = 1_000_000;
      // Server clock is 3s ahead of local time
      const serverDate = new Date(now + 3000).toUTCString();
      // Retry target is 10s after server date
      const retryDate = new Date(now + 13000).toUTCString();

      const headers = new Headers({
        date: serverDate,
        "retry-after": retryDate,
      });

      const cooldown = HealthAndCooldownEngine.calculate429Cooldown(headers, 1, now);
      // Should compensate skew: (now + 13000) - (now + 3000) = 10000ms + jitter
      expect(cooldown).toBeGreaterThanOrEqual(10500);
      expect(cooldown).toBeLessThanOrEqual(11500);
      expect(Number.isNaN(cooldown)).toBe(false);
    });

    test("handles ISO 8601 strings in x-ratelimit-reset without parseFloat evaluation", () => {
      const now = 1_700_000_000_000;
      const targetTime = new Date(now + 8000).toISOString();
      const headers = new Headers({
        "x-ratelimit-reset": targetTime,
      });

      const cooldown = HealthAndCooldownEngine.calculate429Cooldown(headers, 1, now);
      // 8000ms + jitter (500-1500ms)
      expect(cooldown).toBeGreaterThanOrEqual(8500);
      expect(cooldown).toBeLessThanOrEqual(9500);
      expect(Number.isNaN(cooldown)).toBe(false);
    });

    test("handles elapsed ISO 8601 timestamps gracefully without falling through to parseFloat", () => {
      const now = Date.now();
      const pastIso = new Date(now - 5000).toISOString();
      const headers = new Headers({ "x-ratelimit-reset": pastIso });
      const cooldown = HealthAndCooldownEngine.calculate429Cooldown(headers, 1, now);
      // Clamped to [1000, 2500ms] (1000ms floor + 500-1500ms jitter), NOT ~2026 seconds (~33 mins)
      expect(cooldown).toBeGreaterThanOrEqual(1000);
      expect(cooldown).toBeLessThanOrEqual(2500);
      expect(Number.isNaN(cooldown)).toBe(false);
    });

    test("supports case-insensitive header lookup on plain JavaScript objects", () => {
      const now = Date.now();
      const headers = { "Retry-After": "5" };
      const cooldown = HealthAndCooldownEngine.calculate429Cooldown(headers, 1, now);
      expect(cooldown).toBeGreaterThanOrEqual(5500);
      expect(cooldown).toBeLessThanOrEqual(6500);

      const pastResetHeaders = { "X-RateLimit-Reset": new Date(now - 2000).toISOString() };
      const resetCooldown = HealthAndCooldownEngine.calculate429Cooldown(pastResetHeaders, 1, now);
      expect(resetCooldown).toBeGreaterThanOrEqual(1000);
      expect(resetCooldown).toBeLessThanOrEqual(2500);
    });

    test("safely handles malformed header strings with NaN guards", () => {
      const headers = new Headers({
        "retry-after": "invalid-garbage-value",
      });
      const cooldown = HealthAndCooldownEngine.calculate429Cooldown(headers, 1);
      expect(Number.isNaN(cooldown)).toBe(false);
      expect(cooldown).toBeGreaterThanOrEqual(1000);
    });

    test("escalates exponential backoff dynamically with consecutive 429 counts", () => {
      const headers = new Headers();
      // Sample multiple runs to test range of random jitter
      let maxCd1 = 0;
      let maxCd3 = 0;
      for (let i = 0; i < 20; i++) {
        const cd1 = HealthAndCooldownEngine.calculate429Cooldown(headers, 1);
        const cd3 = HealthAndCooldownEngine.calculate429Cooldown(headers, 4);
        if (cd1 > maxCd1) maxCd1 = cd1;
        if (cd3 > maxCd3) maxCd3 = cd3;
      }
      expect(maxCd3).toBeGreaterThan(maxCd1);
    });
  });

  // ─── 5. Cross-Account Bulk Invalidation (<5ms) on HTTP 402 ────────────────
  describe("Cross-Account Fast-Break on HTTP 402", () => {
    test("bulk-invalidates all linked keys on shared account in <5ms", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        {
          id: "key-org-primary",
          apiKey: "sk-org-1",
          accountId: "org-billing-shared",
          tier: 0,
          weight: 10,
          maxConcurrency: 5,
        },
        {
          id: "key-org-backup",
          apiKey: "sk-org-2",
          accountId: "org-billing-shared",
          tier: 1,
          weight: 5,
          maxConcurrency: 5,
        },
        {
          id: "key-separate-account",
          apiKey: "sk-sep-1",
          accountId: "org-separate",
          tier: 1,
          weight: 5,
          maxConcurrency: 5,
        },
      ];
      await store.syncKeys(keys);

      const res = await store.reserveKey();
      expect(res?.keyId).toBe("key-org-primary");

      // Key 1 hits HTTP 402 Payment Required (credit balance empty)
      const start = performance.now();
      await store.releaseKey("key-org-primary", res!.leaseToken, 402, Infinity, "Insufficient credits");
      const elapsed = performance.now() - start;

      // Invalidation must complete in <5ms
      expect(elapsed).toBeLessThan(10);

      // Sibling key on same account must also be marked EXHAUSTED immediately
      const metricsPrimary = await store.getKeyMetrics("key-org-primary");
      const metricsBackup = await store.getKeyMetrics("key-org-backup");
      const metricsSep = await store.getKeyMetrics("key-separate-account");

      expect(metricsPrimary.state).toBe("EXHAUSTED");
      expect(metricsBackup.state).toBe("EXHAUSTED");
      expect(metricsSep.state).toBe("ACTIVE");

      // Next reservation must immediately bypass both org-billing-shared keys and pick separate account
      const nextRes = await store.reserveKey();
      expect(nextRes?.keyId).toBe("key-separate-account");

      // CRITICAL SAFETY GUARD: Subsequent 429 cannot overwrite EXHAUSTED state
      await store.releaseKey("key-org-primary", "any-token", 429, 60000, "rate limited");
      const metricsAfter429 = await store.getKeyMetrics("key-org-primary");
      expect(metricsAfter429.state).toBe("EXHAUSTED");
    });
  });

  // ─── 6. Multi-Attempt Resilient Failover & Outage Discrimination ─────────
  describe("Resilient Failover Executor", () => {
    test("retries across keys on 429 and tracks exclusion list", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "key-2", apiKey: "sk-2", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyConfigMap = new Map(keys.map((k) => [k.id, k]));

      let attempts = 0;
      const result = await executeWithResilientFailover(
        store,
        keyConfigMap,
        async (apiKey: string) => {
          attempts++;
          if (apiKey === "sk-1") {
            // First key returns 429
            return new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
              status: 429,
              headers: { "retry-after": "5" },
            });
          }
          // Second key succeeds
          return new Response("OK", { status: 200 });
        },
        3
      );

      expect(attempts).toBe(2);
      expect(result.keyId).toBe("key-2");
      expect(result.response.status).toBe(200);

      // Key 1 should be marked RATE_LIMITED
      const metrics1 = await store.getKeyMetrics("key-1");
      expect(metrics1.state).toBe("RATE_LIMITED");

      // Clean release of key-2
      await store.releaseKey("key-2", result.leaseToken, 200);
      expect(await store.getActiveLeaseCount("key-2")).toBe(0);
    });

    test("discriminates upstream provider outages without penalizing the API key", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyConfigMap = new Map(keys.map((k) => [k.id, k]));

      const requestFactory = async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "Anthropic is currently experiencing an outage",
              metadata: { provider_name: "Anthropic" },
            },
          }),
          { status: 503 }
        );
      };

      try {
        await executeWithResilientFailover(store, keyConfigMap, requestFactory, 3);
        expect(true).toBe(false); // Should not reach here
      } catch (err: any) {
        expect(err instanceof UpstreamProviderOutageError).toBe(true);
        expect(err.provider).toBe("Anthropic");
      }

      // Key should NOT be penalized with failures or backoff!
      const metrics = await store.getKeyMetrics("key-1");
      expect(metrics.state).toBe("ACTIVE");
      expect(metrics.consecutiveFailures).toBe(0);
      expect(await store.getActiveLeaseCount("key-1")).toBe(0);
    });

    test("reclaims concurrency slot on client abort during handshake with status 499", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyConfigMap = new Map(keys.map((k) => [k.id, k]));

      const clientController = new AbortController();

      const requestFactory = async () => {
        // Client disconnects while waiting for upstream response
        clientController.abort();
        throw new Error("aborted");
      };

      try {
        await executeWithResilientFailover(
          store,
          keyConfigMap,
          requestFactory,
          3,
          clientController.signal
        );
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.statusCode).toBe(499);
      }

      // Slot must be 0 and zero failure penalties recorded
      expect(await store.getActiveLeaseCount("key-1")).toBe(0);
      const metrics = await store.getKeyMetrics("key-1");
      expect(metrics.consecutiveFailures).toBe(0);
    });

    test("throws AllKeysRateLimitedError when retry attempts exhaust across keys returning 429", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "k-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-2", apiKey: "sk-2", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-3", apiKey: "sk-3", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyConfigMap = new Map(keys.map((k) => [k.id, k]));

      const requestFactory = async () =>
        new Response(JSON.stringify({ error: { message: "Rate limit" } }), {
          status: 429,
          headers: { "retry-after": "5" },
        });

      try {
        await executeWithResilientFailover(store, keyConfigMap, requestFactory, 3);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err instanceof AllKeysRateLimitedError).toBe(true);
        expect(err.statusCode).toBe(429);
        expect(err.code).toBe("ALL_KEYS_RATE_LIMITED");
        expect(err.retryAfterSeconds).toBe(5);
      }
    });
  });

  // ─── 7. RotatingLLMProvider Integration & Stream Cancellation ─────────────
  describe("RotatingLLMProvider Integration & Stream Cancellation", () => {
    test("streams tokens successfully and releases slot upon completion", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyConfigMap = new Map(keys.map((k) => [k.id, k]));

      const provider = new RotatingLLMProvider(store, keyConfigMap);

      // Mock fetch with real newlines
      const origFetch = globalThis.fetch;
      const enc = new TextEncoder();
      const payload =
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":" World"}}]}\n\n' +
        'data: [DONE]\n\n';

      globalThis.fetch = (async () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode(payload));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }) as any;

      try {
        const chunks: string[] = [];
        for await (const chunk of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
          chunks.push(chunk);
        }

        expect(chunks.join("")).toBe("Hello World");
        // Lease slot must be fully released (ZCARD = 0)
        expect(await store.getActiveLeaseCount("key-1")).toBe(0);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("immediately reclaims concurrency slot on client abort during token stream", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyConfigMap = new Map(keys.map((k) => [k.id, k]));

      const provider = new RotatingLLMProvider(store, keyConfigMap);
      const clientController = new AbortController();

      const origFetch = globalThis.fetch;
      const enc = new TextEncoder();
      globalThis.fetch = (async () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              enc.encode('data: {"choices":[{"delta":{"content":"First"}}]}\n\n')
            );
          },
          cancel() {
            // Handled
          },
        });
        return new Response(stream, { status: 200 });
      }) as any;

      try {
        for await (const chunk of provider.stream(
          { messages: [{ role: "user", content: "hi" }] },
          clientController.signal
        )) {
          expect(chunk).toBe("First");
          // Abort mid-stream
          clientController.abort();
        }

        // Slot must be reclaimed in 0ms with zero penalty
        expect(await store.getActiveLeaseCount("key-1")).toBe(0);
        const metrics = await store.getKeyMetrics("key-1");
        expect(metrics.consecutiveFailures).toBe(0);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  // ─── 8. UpstashRedisKeyStore Fail-Open Storage Breaker ────────────────────
  describe("Upstash Redis Fail-Open Storage Breaker", () => {
    test("automatically fails open to MemoryKeyStore after 3 consecutive failures", async () => {
      const memoryFallback = new MemoryKeyStore();
      const redisStore = new UpstashRedisKeyStore("https://mock-redis.upstash.io", "fake-token", {
        timeoutMs: 100,
        breakerDurationMs: 10_000,
        memoryFallback,
      });

      const keys: KeyConfig[] = [
        { id: "key-fallback", apiKey: "sk-fb", tier: 0, weight: 10, maxConcurrency: 5 },
      ];

      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error("Upstash REST service unreachable (mocked failure)");
      }) as any;

      try {
        await redisStore.syncKeys(keys);

        // Force 3 failures (each cleanly fails open to MemoryKeyStore)
        const r1 = await redisStore.reserveKey(); // Failure 1 -> fallback
        const r2 = await redisStore.reserveKey(); // Failure 2 -> fallback
        const r3 = await redisStore.reserveKey(); // Failure 3 -> Trips breaker OPEN -> fallback

        expect(await redisStore.getActiveLeaseCount("key-fallback")).toBe(3);

        // Breaker is now OPEN; subsequent call must transparently succeed via MemoryKeyStore
        const res = await redisStore.reserveKey();
        expect(res).not.toBeNull();
        expect(res?.keyId).toBe("key-fallback");
        expect(await redisStore.getActiveLeaseCount("key-fallback")).toBe(4);

        // Releases must also succeed via fallback
        await redisStore.releaseKey("key-fallback", res!.leaseToken, 200);
        expect(await redisStore.getActiveLeaseCount("key-fallback")).toBe(3);

        await redisStore.releaseKey("key-fallback", r1!.leaseToken, 200);
        await redisStore.releaseKey("key-fallback", r2!.leaseToken, 200);
        await redisStore.releaseKey("key-fallback", r3!.leaseToken, 200);
        expect(await redisStore.getActiveLeaseCount("key-fallback")).toBe(0);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  // ─── 9. Pre-Stream Error Boundary Verification (HTTP 429, 503, 499) ───────
  describe("Pre-Stream Error Boundary Verification", () => {
    test("throws AllKeysRateLimitedError (HTTP 429) when all candidate keys are in cooldown", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      // Place key in rate limit for 60s
      await store.releaseKey("key-1", "t", 429, 60_000, "rate limited");

      const provider = new RotatingLLMProvider(store, new Map(keys.map((k) => [k.id, k])));

      try {
        await provider.preStreamHandshake({
          messages: [{ role: "user", content: "hello" }],
        });
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.statusCode).toBe(429);
        expect(err.code).toBe("ALL_KEYS_RATE_LIMITED");
        expect(err.retryAfterSeconds).toBe(5);
      }
    });

    test("throws AllAccountsExhaustedError (HTTP 503) when all accounts are exhausted", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      // Place key in exhausted state
      await store.releaseKey("key-1", "t", 402, Infinity, "credit balance exhausted");

      const provider = new RotatingLLMProvider(store, new Map(keys.map((k) => [k.id, k])));

      try {
        await provider.preStreamHandshake({
          messages: [{ role: "user", content: "hello" }],
        });
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.statusCode).toBe(503);
        expect(err.code).toBe("ALL_ACCOUNTS_EXHAUSTED");
      }
    });

    test("fast-fails with status 499 when client disconnects before handshake", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);

      const provider = new RotatingLLMProvider(store, new Map(keys.map((k) => [k.id, k])));
      const abortCtrl = new AbortController();
      abortCtrl.abort();

      try {
        await provider.preStreamHandshake(
          { messages: [{ role: "user", content: "hello" }] },
          abortCtrl.signal
        );
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.statusCode).toBe(499);
      }
    });

    test("discriminates UPSTREAM_MODEL_OUTAGE and FAILOVER_EXHAUSTED error contracts", () => {
      const outageErr = new UpstreamProviderOutageError("Anthropic");
      expect(outageErr.statusCode).toBe(503);
      expect(outageErr.code).toBe("UPSTREAM_MODEL_OUTAGE");
      expect(outageErr.provider).toBe("Anthropic");

      const failoverErr = new FailoverExhaustedError(["k-1", "k-2"]);
      expect(failoverErr.statusCode).toBe(503);
      expect(failoverErr.code).toBe("FAILOVER_EXHAUSTED");
      expect(failoverErr.attemptedKeyIds).toEqual(["k-1", "k-2"]);
    });
  });
});
