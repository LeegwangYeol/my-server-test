/**
 * High-Concurrency Chaos Stress & Failover Verification Suite
 * Target: test/concurrency-chaos.test.ts
 *
 * Empirically tests:
 * 1. HTTP 429 dynamic backoff with jitter and excludeKeyIds tracking.
 * 2. HTTP 402 cross-account fast-break bulk invalidation in <5ms.
 * 3. Upstream provider outage discrimination (metadata.provider_name) without key penalty.
 * 4. High-concurrency chaos stress test (100 requests) with zero lease leaks (ZCARD = 0).
 */

import { describe, expect, test } from "bun:test";
import {
  MemoryKeyStore,
  WLIFSelectionEngine,
  HealthAndCooldownEngine,
  executeWithResilientFailover,
  AllKeysRateLimitedError,
  AllAccountsExhaustedError,
  UpstreamProviderOutageError,
  KeyManagerError,
  type KeyConfig,
  type KeyCandidate,
} from "../lib/llm/key-manager";

describe("Milestone 1 Empirical Chaos & Concurrency Verification", () => {
  // ─── 1. HTTP 429 Dynamic Backoff with Jitter & Exclusion Tracking ────────
  describe("1. HTTP 429 Dynamic Backoff & Exclusion Tracking", () => {
    test("1.1 retry-after delta-seconds includes randomized positive jitter", () => {
      const headers = new Headers({ "retry-after": "10" });
      const jitterSamples: number[] = [];

      for (let i = 0; i < 30; i++) {
        const cooldown = HealthAndCooldownEngine.calculate429Cooldown(headers, 1);
        expect(cooldown).toBeGreaterThanOrEqual(10_500); // 10s + min 500ms jitter
        expect(cooldown).toBeLessThanOrEqual(11_500); // 10s + max 1500ms jitter
        jitterSamples.push(cooldown);
      }

      // Verify jitter is not static constant
      const uniqueValues = new Set(jitterSamples);
      expect(uniqueValues.size).toBeGreaterThan(1);
    });

    test("1.2 x-ratelimit-reset ISO 8601 parsing handles timestamps safely with jitter", () => {
      const now = 1_720_000_000_000;
      const targetTime = new Date(now + 12_000).toISOString();
      const headers = new Headers({ "x-ratelimit-reset": targetTime });

      const cooldown = HealthAndCooldownEngine.calculate429Cooldown(headers, 1, now);
      expect(cooldown).toBeGreaterThanOrEqual(12_500);
      expect(cooldown).toBeLessThanOrEqual(13_500);
      expect(Number.isNaN(cooldown)).toBe(false);
    });

    test("1.3 Fallback exponential backoff escalates with consecutive429s with full jitter", () => {
      const emptyHeaders = new Headers();
      // Test exponential backoff cap: 2000 * 2^consecutive
      // consecutive = 1: base cap = min(60000, 2000 * 2^1) = 4000ms. random(0..4000) + 500 -> 500..4500ms
      // consecutive = 5: base cap = min(60000, 2000 * 2^5) = 60000ms. random(0..60000) + 500 -> 500..60500ms
      let maxSample1 = 0;
      let maxSample5 = 0;

      for (let i = 0; i < 50; i++) {
        const cd1 = HealthAndCooldownEngine.calculate429Cooldown(emptyHeaders, 1);
        const cd5 = HealthAndCooldownEngine.calculate429Cooldown(emptyHeaders, 5);
        expect(cd1).toBeGreaterThanOrEqual(1000);
        expect(cd5).toBeGreaterThanOrEqual(1000);
        expect(cd5).toBeLessThanOrEqual(60_500);
        if (cd1 > maxSample1) maxSample1 = cd1;
        if (cd5 > maxSample5) maxSample5 = cd5;
      }

      expect(maxSample5).toBeGreaterThan(maxSample1);
    });

    test("1.4 Failover loop excludes already-attempted key on 429 and succeeds on next key", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-primary", apiKey: "sk-primary", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "key-secondary", apiKey: "sk-secondary", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyMap = new Map(keys.map((k) => [k.id, k]));

      const dispatchHistory: string[] = [];

      const result = await executeWithResilientFailover(
        store,
        keyMap,
        async (apiKey: string) => {
          dispatchHistory.push(apiKey);
          if (apiKey === "sk-primary") {
            return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
              status: 429,
              headers: { "retry-after": "3" },
            });
          }
          return new Response(JSON.stringify({ choices: [{ delta: { content: "ok" } }] }), {
            status: 200,
          });
        },
        3
      );

      // Verify attempts sequence
      expect(dispatchHistory).toEqual(["sk-primary", "sk-secondary"]);
      expect(result.keyId).toBe("key-secondary");
      expect(result.response.status).toBe(200);

      // Verify primary key is quarantined in RATE_LIMITED with cooldown
      const metricsPrimary = await store.getKeyMetrics("key-primary");
      expect(metricsPrimary.state).toBe("RATE_LIMITED");
      expect(metricsPrimary.consecutive429s).toBe(1);
      expect(metricsPrimary.cooldownUntil).toBeGreaterThan(Date.now());

      // Release secondary key
      await store.releaseKey("key-secondary", result.leaseToken, 200);
      expect(await store.getActiveLeaseCount("key-secondary")).toBe(0);
      expect(await store.getActiveLeaseCount("key-primary")).toBe(0);
    });

    test("1.5 When all keys return 429, throws AllKeysRateLimitedError and leaves zero lease leaks", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "key-2", apiKey: "sk-2", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyMap = new Map(keys.map((k) => [k.id, k]));

      const callLog: string[] = [];

      try {
        await executeWithResilientFailover(
          store,
          keyMap,
          async (apiKey: string) => {
            callLog.push(apiKey);
            return new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
              status: 429,
              headers: { "retry-after": "5" },
            });
          },
          3
        );
        expect(true).toBe(false); // Should throw
      } catch (err: any) {
        expect(err instanceof AllKeysRateLimitedError).toBe(true);
        expect(err.statusCode).toBe(429);
        expect(err.retryAfterSeconds).toBe(5);
      }

      // Exactly 2 attempts (both keys tried once, no duplicate retry on key-1)
      expect(callLog).toEqual(["sk-1", "sk-2"]);

      // Verify ZSET zero-leak guarantee: All leases must be 0
      expect(await store.getActiveLeaseCount("key-1")).toBe(0);
      expect(await store.getActiveLeaseCount("key-2")).toBe(0);
    });

    test("1.6 When maxAttempts exactly matches keys count (or 1), throws AllKeysRateLimitedError on 429", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "key-2", apiKey: "sk-2", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyMap = new Map(keys.map((k) => [k.id, k]));

      try {
        await executeWithResilientFailover(
          store,
          keyMap,
          async () => new Response("Rate limited", { status: 429, headers: { "retry-after": "5" } }),
          2 // maxAttempts === keys.length
        );
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err instanceof AllKeysRateLimitedError).toBe(true);
        expect(err.statusCode).toBe(429);
        expect(err.code).toBe("ALL_KEYS_RATE_LIMITED");
        expect(err.retryAfterSeconds).toBe(5);
      }

      // Single attempt case
      try {
        await executeWithResilientFailover(
          store,
          keyMap,
          async () => new Response("Rate limited", { status: 429 }),
          1
        );
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err instanceof AllKeysRateLimitedError).toBe(true);
        expect(err.statusCode).toBe(429);
        expect(err.code).toBe("ALL_KEYS_RATE_LIMITED");
      }
    });
  });

  // ─── 2. HTTP 402 Cross-Account Fast-Break Bulk Invalidation (<5ms) ──────
  describe("2. HTTP 402 Cross-Account Fast-Break Bulk Invalidation (<5ms)", () => {
    test("2.1 Bulk invalidates 20 keys sharing an account in <5ms", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [];

      // Create 20 keys sharing account-shared
      for (let i = 0; i < 20; i++) {
        keys.push({
          id: `key-shared-${i}`,
          apiKey: `sk-shared-${i}`,
          accountId: "account-shared-corp",
          tier: i === 0 ? 0 : 1,
          weight: 5,
          maxConcurrency: 5,
        });
      }
      // Add 1 key on a separate healthy account
      keys.push({
        id: "key-healthy-acc",
        apiKey: "sk-healthy",
        accountId: "account-isolated-corp",
        tier: 1,
        weight: 5,
        maxConcurrency: 5,
      });

      await store.syncKeys(keys);

      // Reserve key-shared-0
      const res = await store.reserveKey();
      expect(res).not.toBeNull();
      expect(res?.keyId).toBe("key-shared-0");

      // Measure invalidation latency
      const start = performance.now();
      await store.releaseKey("key-shared-0", res!.leaseToken, 402, Infinity, "Credits drained");
      const elapsedMs = performance.now() - start;

      // Invalidation latency MUST be < 5ms
      expect(elapsedMs).toBeLessThan(5.0);

      // All 20 linked keys must now be marked EXHAUSTED
      for (let i = 0; i < 20; i++) {
        const m = await store.getKeyMetrics(`key-shared-${i}`);
        expect(m.state).toBe("EXHAUSTED");
      }

      // Healthy account must remain ACTIVE
      const mHealthy = await store.getKeyMetrics("key-healthy-acc");
      expect(mHealthy.state).toBe("ACTIVE");

      // Subsequent reservation immediately yields key-healthy-acc without touching any shared key
      const nextRes = await store.reserveKey();
      expect(nextRes).not.toBeNull();
      expect(nextRes?.keyId).toBe("key-healthy-acc");

      await store.releaseKey("key-healthy-acc", nextRes!.leaseToken, 200);
    });

    test("2.2 Fast-break in failover loop bypasses all linked keys without network calls", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-a1", apiKey: "sk-a1", accountId: "acc-bankrupt", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "key-a2", apiKey: "sk-a2", accountId: "acc-bankrupt", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "key-a3", apiKey: "sk-a3", accountId: "acc-bankrupt", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "key-b1", apiKey: "sk-b1", accountId: "acc-funded", tier: 1, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyMap = new Map(keys.map((k) => [k.id, k]));

      const attemptedApiKeys: string[] = [];

      const result = await executeWithResilientFailover(
        store,
        keyMap,
        async (apiKey: string) => {
          attemptedApiKeys.push(apiKey);
          if (apiKey.startsWith("sk-a")) {
            return new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), {
              status: 402,
            });
          }
          return new Response("OK", { status: 200 });
        },
        4
      );

      // CRITICAL FAST-BREAK VERIFICATION:
      // key-a1 failed with 402.
      // key-a2 and key-a3 must NOT be called over the network!
      // The failover must jump straight to key-b1 (sk-b1).
      expect(attemptedApiKeys).toEqual(["sk-a1", "sk-b1"]);
      expect(result.keyId).toBe("key-b1");
      expect(result.response.status).toBe(200);

      await store.releaseKey("key-b1", result.leaseToken, 200);
      expect(await store.getActiveLeaseCount("key-b1")).toBe(0);
      expect(await store.getActiveLeaseCount("key-a1")).toBe(0);
    });

    test("2.3 EXHAUSTED state is immutable: trailing 429 cannot overwrite permanent 402", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-immutable", apiKey: "sk-imm", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);

      const res = await store.reserveKey();
      expect(res).not.toBeNull();

      // Trigger 402
      await store.releaseKey("key-immutable", res!.leaseToken, 402, Infinity, "Balance zero");
      let metrics = await store.getKeyMetrics("key-immutable");
      expect(metrics.state).toBe("EXHAUSTED");

      // Trailing in-flight request finishes with 429
      await store.releaseKey("key-immutable", "fake-token", 429, 5000, "rate limited");
      metrics = await store.getKeyMetrics("key-immutable");
      expect(metrics.state).toBe("EXHAUSTED"); // Must NOT be overwritten to RATE_LIMITED!

      // Trailing in-flight request finishes with 200
      await store.releaseKey("key-immutable", "fake-token", 200);
      metrics = await store.getKeyMetrics("key-immutable");
      expect(metrics.state).toBe("EXHAUSTED"); // Must NOT be overwritten to ACTIVE!
    });

    test("2.4 When all accounts are exhausted, throws AllAccountsExhaustedError (503)", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-1", apiKey: "sk-1", accountId: "acc-1", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "key-2", apiKey: "sk-2", accountId: "acc-2", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyMap = new Map(keys.map((k) => [k.id, k]));

      try {
        await executeWithResilientFailover(
          store,
          keyMap,
          async () => new Response("Out of credits", { status: 402 }),
          3
        );
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err instanceof AllAccountsExhaustedError).toBe(true);
        expect(err.statusCode).toBe(503);
        expect(err.code).toBe("ALL_ACCOUNTS_EXHAUSTED");
      }
    });
  });

  // ─── 3. Upstream Provider Outage Discrimination ──────────────────────────
  describe("3. Upstream Provider Outage Discrimination", () => {
    test("3.1 Provider outage on HTTP 429 does not penalize healthy keys", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-claude", apiKey: "sk-claude", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyMap = new Map(keys.map((k) => [k.id, k]));

      const requestFactory = async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "Anthropic rate limit reached for model claude-3.5-sonnet",
              metadata: { provider_name: "Anthropic" },
            },
          }),
          { status: 429 }
        );
      };

      try {
        await executeWithResilientFailover(store, keyMap, requestFactory, 3);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err instanceof UpstreamProviderOutageError).toBe(true);
        expect((err as UpstreamProviderOutageError).provider).toBe("Anthropic");
      }

      // Key must NOT be penalized:
      // State must be ACTIVE, consecutive429s must be 0, active leases must be 0!
      const metrics = await store.getKeyMetrics("key-claude");
      expect(metrics.state).toBe("ACTIVE");
      expect(metrics.consecutive429s).toBe(0);
      expect(metrics.consecutiveFailures).toBe(0);
      expect(await store.getActiveLeaseCount("key-claude")).toBe(0);
    });

    test("3.2 Provider outage on HTTP 503 does not penalize healthy keys", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-openai", apiKey: "sk-openai", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyMap = new Map(keys.map((k) => [k.id, k]));

      const requestFactory = async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "OpenAI is experiencing widespread downtime",
              metadata: { provider_name: "OpenAI" },
            },
          }),
          { status: 503 }
        );
      };

      try {
        await executeWithResilientFailover(store, keyMap, requestFactory, 3);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err instanceof UpstreamProviderOutageError).toBe(true);
        expect((err as UpstreamProviderOutageError).provider).toBe("OpenAI");
      }

      // Key must NOT be penalized:
      const metrics = await store.getKeyMetrics("key-openai");
      expect(metrics.state).toBe("ACTIVE");
      expect(metrics.consecutiveFailures).toBe(0);
      expect(await store.getActiveLeaseCount("key-openai")).toBe(0);
    });

    test("3.3 Substring discrimination catches un-structured provider outage messages", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-generic", apiKey: "sk-gen", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyMap = new Map(keys.map((k) => [k.id, k]));

      const requestFactory = async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "Upstream provider returned 503: model is currently overloaded",
            },
          }),
          { status: 503 }
        );
      };

      try {
        await executeWithResilientFailover(store, keyMap, requestFactory, 3);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err instanceof UpstreamProviderOutageError).toBe(true);
      }

      const metrics = await store.getKeyMetrics("key-generic");
      expect(metrics.state).toBe("ACTIVE");
      expect(metrics.consecutiveFailures).toBe(0);
      expect(await store.getActiveLeaseCount("key-generic")).toBe(0);
    });

    test("3.4 Genuine key-level rate limits are NOT treated as provider outages", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-quota", apiKey: "sk-quota", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyMap = new Map(keys.map((k) => [k.id, k]));

      const requestFactory = async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "You have exceeded your account's rate limit of 200 RPM.",
            },
          }),
          { status: 429, headers: { "retry-after": "5" } }
        );
      };

      try {
        // With default maxAttempts (3), second attempt reserves with attemptedKeyIds,
        // finds no keys available, and throws AllKeysRateLimitedError
        await executeWithResilientFailover(store, keyMap, requestFactory, 3);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err instanceof AllKeysRateLimitedError).toBe(true);
        expect(err.statusCode).toBe(429);
      }

      // This key MUST be marked RATE_LIMITED with cooldown!
      const metrics = await store.getKeyMetrics("key-quota");
      expect(metrics.state).toBe("RATE_LIMITED");
      expect(metrics.consecutive429s).toBe(1);
      expect(metrics.cooldownUntil).toBeGreaterThan(Date.now());
      expect(await store.getActiveLeaseCount("key-quota")).toBe(0);
    });
  });

  // ─── 4. High-Concurrency Chaos Stress Harness (100 Requests Swarm) ───────
  describe("4. High-Concurrency Chaos Stress Harness (100 Requests)", () => {
    test("100 concurrent requests with chaos error injection produce zero lease leaks (ZCARD = 0)", async () => {
      const store = new MemoryKeyStore({ defaultMaxConcurrency: 15 });
      const keys: KeyConfig[] = [
        { id: "k-pool-0", apiKey: "sk-0", accountId: "acc-alpha", tier: 0, weight: 10, maxConcurrency: 10 },
        { id: "k-pool-1", apiKey: "sk-1", accountId: "acc-alpha", tier: 0, weight: 10, maxConcurrency: 10 },
        { id: "k-pool-2", apiKey: "sk-2", accountId: "acc-beta", tier: 0, weight: 10, maxConcurrency: 10 },
        { id: "k-pool-3", apiKey: "sk-3", accountId: "acc-beta", tier: 0, weight: 10, maxConcurrency: 10 },
        { id: "k-pool-4", apiKey: "sk-4", accountId: "acc-gamma", tier: 1, weight: 5, maxConcurrency: 10 },
      ];
      await store.syncKeys(keys);
      const keyMap = new Map(keys.map((k) => [k.id, k]));

      const totalRequests = 100;
      let okCount = 0;
      let rateLimitCount = 0;
      let accountExhaustedCount = 0;
      let providerOutageCount = 0;
      let clientAbortCount = 0;
      let otherCount = 0;

      const promises = Array.from({ length: totalRequests }).map(async (_, idx) => {
        const clientController = new AbortController();

        // 5% client abort simulation
        if (idx % 20 === 19) {
          setTimeout(() => clientController.abort(), 2);
        }

        try {
          const res = await executeWithResilientFailover(
            store,
            keyMap,
            async (apiKey: string, signal?: AbortSignal) => {
              // Simulated network latency (1 to 10ms)
              await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 10) + 1));

              if (signal?.aborted) {
                throw new Error("aborted");
              }

              // Chaos injection based on request index:
              // idx % 10 == 0: 402 on acc-alpha
              if (idx % 10 === 0 && (apiKey === "sk-0" || apiKey === "sk-1")) {
                return new Response(JSON.stringify({ error: { message: "Account credits depleted" } }), {
                  status: 402,
                });
              }

              // idx % 5 == 0: 429 with jitter header
              if (idx % 5 === 0) {
                return new Response(JSON.stringify({ error: { message: "Rate limit" } }), {
                  status: 429,
                  headers: { "retry-after": "1" },
                });
              }

              // idx % 7 == 0: Upstream provider outage
              if (idx % 7 === 0) {
                return new Response(
                  JSON.stringify({
                    error: {
                      message: "Provider unavailable",
                      metadata: { provider_name: "Anthropic" },
                    },
                  }),
                  { status: 503 }
                );
              }

              // Normal 200 OK
              return new Response(JSON.stringify({ choices: [{ delta: { content: "ok" } }] }), {
                status: 200,
              });
            },
            3,
            clientController.signal
          );

          okCount++;
          // Release lease normally upon completion
          await store.releaseKey(res.keyId, res.leaseToken, 200);
        } catch (err: any) {
          if (err instanceof AllKeysRateLimitedError) {
            rateLimitCount++;
          } else if (err instanceof AllAccountsExhaustedError) {
            accountExhaustedCount++;
          } else if (err instanceof UpstreamProviderOutageError) {
            providerOutageCount++;
          } else if (err?.statusCode === 499 || err?.message?.includes("aborted")) {
            clientAbortCount++;
          } else {
            otherCount++;
          }
        }
      });

      const startTime = performance.now();
      await Promise.all(promises);
      const totalDuration = performance.now() - startTime;

      // Assertions:
      // 1. All 100 requests finished
      const totalResolved = okCount + rateLimitCount + accountExhaustedCount + providerOutageCount + clientAbortCount + otherCount;
      expect(totalResolved).toBe(totalRequests);

      // 2. High concurrency throughput (all 100 requests completed within 5 seconds)
      expect(totalDuration).toBeLessThan(5000);

      // 3. ZERO LEASE LEAKS GUARANTEE:
      // Authoritative ZCARD across ALL keys in the pool must be EXACTLY 0!
      for (const k of keys) {
        const activeLeases = await store.getActiveLeaseCount(k.id);
        expect(activeLeases).toBe(0);
      }
    });
  });
});
