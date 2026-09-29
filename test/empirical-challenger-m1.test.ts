import { describe, expect, test } from "bun:test";
import {
  MemoryKeyStore,
  UpstashRedisKeyStore,
  RotatingLLMProvider,
  executeWithResilientFailover,
  KeyManagerError,
  type KeyConfig,
  type KeyCandidate,
  type KeyRuntimeState,
} from "../lib/llm/key-manager";

describe("Milestone 1 Empirical Challenger: Concurrency & Lease Invariants", () => {
  // ─── 1. Expired Leases Pruned Atomically (ZREMRANGEBYSCORE -inf now) ─────
  describe("Invariant 1: Expired Leases Self-Pruning Atomicity", () => {
    test("staggered lease expiration accurately prunes only expired leases and preserves valid ones", async () => {
      let now = 1_000_000;
      const store = new MemoryKeyStore({
        clock: () => now,
        leaseTimeoutMs: 5_000, // 5s TTL
      });

      const keys: KeyConfig[] = [
        { id: "key-staggered", apiKey: "sk-stag", tier: 0, weight: 10, maxConcurrency: 20 },
      ];
      await store.syncKeys(keys);

      const leases: Array<{ token: string; createdAt: number }> = [];

      // Create 10 leases staggered by 1 second each
      for (let i = 0; i < 10; i++) {
        now = 1_000_000 + i * 1_000;
        const res = await store.reserveKey();
        expect(res).not.toBeNull();
        leases.push({ token: res!.leaseToken, createdAt: now });
      }

      // At now = 1_009_000 (after 10th lease):
      // Leases 0 to 4 (created at 1000k, 1001k, 1002k, 1003k, 1004k) expire at (1005k, 1006k, 1007k, 1008k, 1009k)
      // At now = 1_009_000, leases 0..4 have reached or passed their expireAt.
      // Leases 5..9 expire at 1010k, 1011k, 1012k, 1013k, 1014k (still valid).
      const activeCount = await store.getActiveLeaseCount("key-staggered");
      expect(activeCount).toBe(5);

      // Verify exact active count matches 5
      const metrics = await store.getKeyMetrics("key-staggered");
      expect(metrics.inFlightRequests).toBe(5);

      // Advance time to 1_020_000 (all 10 leases expired)
      now = 1_020_000;
      // Reserving 1 new lease triggers atomic purge of all remaining 5 expired leases
      const newRes = await store.reserveKey();
      expect(newRes).not.toBeNull();

      // Cardinality should now be exactly 1
      expect(await store.getActiveLeaseCount("key-staggered")).toBe(1);

      // Clean release of the new lease
      await store.releaseKey("key-staggered", newRes!.leaseToken, 200);
      expect(await store.getActiveLeaseCount("key-staggered")).toBe(0);
    });

    test("boundary condition: lease is pruned exactly when now >= expireAt", async () => {
      let now = 50_000;
      const store = new MemoryKeyStore({
        clock: () => now,
        leaseTimeoutMs: 10_000,
      });

      await store.syncKeys([
        { id: "key-boundary", apiKey: "sk-b", tier: 0, weight: 10, maxConcurrency: 5 },
      ]);

      const res = await store.reserveKey();
      expect(res).not.toBeNull();
      // expireAt = 50_000 + 10_000 = 60_000

      // At now = 59_999 (1ms before expiration) -> lease is still ACTIVE
      now = 59_999;
      expect(await store.getActiveLeaseCount("key-boundary")).toBe(1);

      // At now = 60_000 (exact expiration) -> lease is PRUNED
      now = 60_000;
      expect(await store.getActiveLeaseCount("key-boundary")).toBe(0);
    });

    test("mass expiration under high concurrency: 100 dead leases pruned in 1 operation", async () => {
      let now = 100_000;
      const store = new MemoryKeyStore({
        clock: () => now,
        leaseTimeoutMs: 3_000,
      });

      await store.syncKeys([
        { id: "key-mass", apiKey: "sk-mass", tier: 0, weight: 10, maxConcurrency: 150 },
      ]);

      // Acquire 100 leases (advance now by 1ms per lease to simulate sequential timestamps)
      for (let i = 0; i < 100; i++) {
        now += 1;
        const r = await store.reserveKey();
        expect(r).not.toBeNull();
      }
      expect(await store.getActiveLeaseCount("key-mass")).toBe(100);

      // Advance time past TTL
      now += 4_000;

      // Reserving a single key must prune all 100 dead leases and return new lease
      const freshRes = await store.reserveKey();
      expect(freshRes).not.toBeNull();
      expect(await store.getActiveLeaseCount("key-mass")).toBe(1);

      await store.releaseKey("key-mass", freshRes!.leaseToken, 200);
      expect(await store.getActiveLeaseCount("key-mass")).toBe(0);
    });

    test("adversarial vulnerability: same-millisecond birthday collisions on 5-digit nonce in MemoryKeyStore", async () => {
      // Freezing clock at exact same millisecond
      const frozenNow = 500_000;
      const store = new MemoryKeyStore({
        clock: () => frozenNow,
        leaseTimeoutMs: 10_000,
      });

      await store.syncKeys([
        { id: "key-collision", apiKey: "sk-col", tier: 0, weight: 10, maxConcurrency: 500 },
      ]);

      const acquiredTokens = new Set<string>();
      let collisions = 0;

      // Acquire 300 leases at the exact same millisecond
      for (let i = 0; i < 300; i++) {
        const r = await store.reserveKey();
        if (r) {
          if (acquiredTokens.has(r.leaseToken)) {
            collisions++;
          }
          acquiredTokens.add(r.leaseToken);
        }
      }

      // At N=300 in 90,000 space, birthday collision probability is >39%!
      // Document empirical collision count
      console.log(`[Challenger 1 Observation] Same-millisecond leaseToken collisions (N=300): ${collisions}`);
      expect(acquiredTokens.size).toBeLessThanOrEqual(300);
    });
  });

  // ─── 2. Active Lease Cardinality Matching Authoritative ZCARD ─────────────
  describe("Invariant 2: Active Lease Cardinality vs ZCARD", () => {
    test("strict maxConcurrency enforcement under parallel reservation burst", async () => {
      const store = new MemoryKeyStore();
      const MAX_CONCURRENCY = 7;

      await store.syncKeys([
        {
          id: "key-quota",
          apiKey: "sk-quota",
          tier: 0,
          weight: 10,
          maxConcurrency: MAX_CONCURRENCY,
        },
      ]);

      // Fire 50 simultaneous parallel reservation requests
      const reservationPromises = Array.from({ length: 50 }, () => store.reserveKey());
      const results = await Promise.all(reservationPromises);

      const successful = results.filter((r) => r !== null);
      const rejected = results.filter((r) => r === null);

      // Invariant: EXACTLY MAX_CONCURRENCY reservations succeed, remainder rejected
      expect(successful.length).toBe(MAX_CONCURRENCY);
      expect(rejected.length).toBe(50 - MAX_CONCURRENCY);

      // Invariant: getActiveLeaseCount and getKeyMetrics match ZCARD
      expect(await store.getActiveLeaseCount("key-quota")).toBe(MAX_CONCURRENCY);
      const metrics = await store.getKeyMetrics("key-quota");
      expect(metrics.inFlightRequests).toBe(MAX_CONCURRENCY);

      const states = await store.getAllStates();
      const state = states.find((s) => s.id === "key-quota");
      expect(state?.inFlightRequests).toBe(MAX_CONCURRENCY);

      // Release all successful leases
      for (const res of successful) {
        await store.releaseKey("key-quota", res!.leaseToken, 200);
      }

      expect(await store.getActiveLeaseCount("key-quota")).toBe(0);
    });

    test("interleaved concurrent reservations and releases maintain zero counter drift", async () => {
      const store = new MemoryKeyStore();
      const MAX_CONCURRENCY = 15;

      await store.syncKeys([
        {
          id: "key-interleaved",
          apiKey: "sk-int",
          tier: 0,
          weight: 10,
          maxConcurrency: MAX_CONCURRENCY,
        },
      ]);

      const activeTokens = new Set<string>();

      // Perform 200 random operations (reserve / release)
      for (let cycle = 0; cycle < 200; cycle++) {
        const shouldReserve = Math.random() < 0.6; // 60% chance to reserve
        if (shouldReserve && activeTokens.size < MAX_CONCURRENCY) {
          const res = await store.reserveKey();
          if (res) {
            activeTokens.add(res.leaseToken);
          }
        } else if (activeTokens.size > 0) {
          const tokenToRelease = Array.from(activeTokens)[0];
          activeTokens.delete(tokenToRelease);
          await store.releaseKey("key-interleaved", tokenToRelease, 200);
        }

        // Live check: store cardinality MUST equal activeTokens.size
        const count = await store.getActiveLeaseCount("key-interleaved");
        expect(count).toBe(activeTokens.size);
      }

      // Drain all remaining active tokens
      for (const token of activeTokens) {
        await store.releaseKey("key-interleaved", token, 200);
      }

      expect(await store.getActiveLeaseCount("key-interleaved")).toBe(0);
    });
  });

  // ─── 3. 100% Reclamation / Zero-Concurrency Leak Invariant ────────────────
  describe("Invariant 3: Zero-Concurrency Leak Reclamation", () => {
    test("100% reclaimed (returns to 0) after 100 requests complete normally", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "k-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 50 },
        { id: "k-2", apiKey: "sk-2", tier: 0, weight: 10, maxConcurrency: 50 },
      ];
      await store.syncKeys(keys);

      // Run 100 concurrent requests with random delays
      const runRequest = async () => {
        const res = await store.reserveKey();
        expect(res).not.toBeNull();
        await new Promise((r) => setTimeout(r, Math.random() * 10 + 2));
        await store.releaseKey(res!.keyId, res!.leaseToken, 200);
      };

      await Promise.all(Array.from({ length: 100 }, () => runRequest()));

      expect(await store.getActiveLeaseCount("k-1")).toBe(0);
      expect(await store.getActiveLeaseCount("k-2")).toBe(0);
    });

    test("100% reclaimed when client aborts during handshake (status 499)", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-abort-hs", apiKey: "sk-abhs", tier: 0, weight: 10, maxConcurrency: 20 },
      ];
      await store.syncKeys(keys);

      const configMap = new Map<string, KeyConfig>(keys.map((k) => [k.id, k]));

      // 10 concurrent requests that abort while waiting for response
      const abortTasks = Array.from({ length: 10 }, async () => {
        const clientController = new AbortController();

        const fakeRequestFactory = async (_apiKey: string, _attemptSignal?: AbortSignal) => {
          // Abort after 5ms
          setTimeout(() => clientController.abort(), 5);
          await new Promise((_, reject) => {
            clientController.signal.addEventListener("abort", () => {
              reject(new Error("CLIENT_ABORTED"));
            });
          });
          return new Response("OK");
        };

        try {
          await executeWithResilientFailover(
            store,
            configMap,
            fakeRequestFactory,
            3,
            clientController.signal
          );
        } catch (err: any) {
          expect(err).toBeInstanceOf(KeyManagerError);
          expect(err.statusCode).toBe(499);
        }
      });

      await Promise.all(abortTasks);

      // Invariant: lease count MUST be exactly 0
      expect(await store.getActiveLeaseCount("key-abort-hs")).toBe(0);
    });

    test("100% reclaimed when client aborts mid-stream in RotatingLLMProvider", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "key-stream-abort", apiKey: "sk-sa", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);

      const configMap = new Map<string, KeyConfig>(keys.map((k) => [k.id, k]));
      const provider = new RotatingLLMProvider(store, configMap);

      const origFetch = globalThis.fetch;

      // Mock an infinite SSE stream from OpenRouter
      globalThis.fetch = (async (_url: any, _init: any) => {
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            for (let i = 0; i < 100; i++) {
              controller.enqueue(
                enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `chunk-${i} ` } }] })}\n\n`)
              );
              await new Promise((r) => setTimeout(r, 10));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }) as any;

      try {
        // Run 5 streaming requests that abort after receiving 3 chunks
        const tasks = Array.from({ length: 5 }, async () => {
          const clientController = new AbortController();
          const tokens: string[] = [];

          const stream = provider.stream(
            { messages: [{ role: "user", content: "hi" }] },
            clientController.signal
          );

          try {
            for await (const token of stream) {
              tokens.push(token);
              if (tokens.length >= 3) {
                clientController.abort();
              }
            }
          } catch {
            /* ignore abort exception */
          }
        });

        await Promise.all(tasks);

        // Invariant: After stream aborted mid-way, lease count MUST be exactly 0
        expect(await store.getActiveLeaseCount("key-stream-abort")).toBe(0);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("releasing an expired lease does not corrupt active leases or go negative", async () => {
      let now = 10_000;
      const store = new MemoryKeyStore({
        clock: () => now,
        leaseTimeoutMs: 5_000,
      });

      await store.syncKeys([
        { id: "key-expiry-race", apiKey: "sk-er", tier: 0, weight: 10, maxConcurrency: 5 },
      ]);

      // 1. Reserve Lease A
      const leaseA = await store.reserveKey();
      expect(leaseA).not.toBeNull();
      expect(await store.getActiveLeaseCount("key-expiry-race")).toBe(1);

      // 2. Advance time past Lease A's TTL (Lease A is now dead)
      now += 6_000;

      // 3. Reserve Lease B (prunes Lease A)
      const leaseB = await store.reserveKey();
      expect(leaseB).not.toBeNull();
      expect(leaseB?.leaseToken).not.toBe(leaseA?.leaseToken);
      expect(await store.getActiveLeaseCount("key-expiry-race")).toBe(1);

      // 4. Request A finally finishes and calls releaseKey with Lease A's expired token
      await store.releaseKey("key-expiry-race", leaseA!.leaseToken, 200);

      // CRITICAL ASSERTION: Calling releaseKey on Lease A MUST NOT delete Lease B!
      expect(await store.getActiveLeaseCount("key-expiry-race")).toBe(1);

      // Calling releaseKey again with Lease A (double release) must be idempotent
      await store.releaseKey("key-expiry-race", leaseA!.leaseToken, 200);
      expect(await store.getActiveLeaseCount("key-expiry-race")).toBe(1);

      // 5. Now release Lease B cleanly
      await store.releaseKey("key-expiry-race", leaseB!.leaseToken, 200);
      expect(await store.getActiveLeaseCount("key-expiry-race")).toBe(0);

      // Double-releasing Lease B must also be safe
      await store.releaseKey("key-expiry-race", leaseB!.leaseToken, 200);
      expect(await store.getActiveLeaseCount("key-expiry-race")).toBe(0);
    });
  });

  // ─── 4. Upstash REST Store Pipeline & Lua Execution Emulation ─────────────
  describe("Invariant 4: Upstash REST Protocol & Pipeline Correctness", () => {
    test("mock Upstash REST pipeline executes ZREMRANGEBYSCORE and ZCARD faithfully", async () => {
      const mockZSet = new Map<string, number>(); // token -> score
      const mockHashes = new Map<string, Record<string, string>>();

      // Mock Bun HTTP server emulating Upstash REST
      const mockServer = Bun.serve({
        port: 0, // OS assigns ephemeral port
        async fetch(req) {
          const url = new URL(req.url);

          if (url.pathname === "/pipeline") {
            const commands = (await req.json()) as any[][];
            const responses: any[] = [];

            for (const cmd of commands) {
              const op = cmd[0].toUpperCase();
              if (op === "ZREMRANGEBYSCORE") {
                const zsetKey = cmd[1];
                const min = cmd[2];
                const max = Number(cmd[3]);
                let pruned = 0;
                for (const [member, score] of mockZSet.entries()) {
                  if (score <= max) {
                    mockZSet.delete(member);
                    pruned++;
                  }
                }
                responses.push({ result: pruned });
              } else if (op === "ZCARD") {
                responses.push({ result: mockZSet.size });
              } else if (op === "HMGET") {
                responses.push({ result: ["ACTIVE", "0", "0", "0", "0", "0"] });
              } else if (op === "SADD" || op === "HSETNX") {
                responses.push({ result: 1 });
              } else {
                responses.push({ result: "OK" });
              }
            }
            return Response.json(responses);
          }

          if (url.pathname === "/eval") {
            // Emulate RESERVE_KEY_LUA
            const [script, keyCount, ...rest] = (await req.json()) as any[];
            const token = `key-upstash:${Date.now()}:${Math.floor(Math.random() * 10000)}`;
            mockZSet.set(token, Date.now() + 45_000);
            return Response.json({ result: ["key-upstash", token] });
          }

          return Response.json({ result: "OK" });
        },
      });

      try {
        const upstashStore = new UpstashRedisKeyStore(
          `http://localhost:${mockServer.port}`,
          "mock-token",
          { timeoutMs: 1000 }
        );

        await upstashStore.syncKeys([
          { id: "key-upstash", apiKey: "sk-up", tier: 0, weight: 10, maxConcurrency: 5 },
        ]);

        // Reserve 1 key
        const res = await upstashStore.reserveKey();
        expect(res).not.toBeNull();
        expect(res?.keyId).toBe("key-upstash");

        // getActiveLeaseCount queries pipeline: ZREMRANGEBYSCORE and ZCARD
        const count = await upstashStore.getActiveLeaseCount("key-upstash");
        expect(count).toBe(1);

        // Pre-populate mockZSet with 3 expired leases
        mockZSet.set("old-token-1", Date.now() - 10_000);
        mockZSet.set("old-token-2", Date.now() - 5_000);
        mockZSet.set("old-token-3", Date.now() - 1_000);

        // Total in mockZSet is now 4 (1 valid, 3 expired)
        expect(mockZSet.size).toBe(4);

        // getActiveLeaseCount will pipeline ZREMRANGEBYSCORE -inf now, then ZCARD
        const prunedCount = await upstashStore.getActiveLeaseCount("key-upstash");
        expect(prunedCount).toBe(1);
        expect(mockZSet.size).toBe(1);
      } finally {
        mockServer.stop();
      }
    });
  });

  // ─── 5. Adversarial Challenge: Failover Exhaustion Classification ─────────
  describe("Adversarial Challenge: Final Attempt 429 Error Classification", () => {
    test("when all attempts exhaust via 429, verifies error thrown by executeWithResilientFailover", async () => {
      const store = new MemoryKeyStore();
      const keys: KeyConfig[] = [
        { id: "k-1", apiKey: "sk-1", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-2", apiKey: "sk-2", tier: 0, weight: 10, maxConcurrency: 5 },
        { id: "k-3", apiKey: "sk-3", tier: 0, weight: 10, maxConcurrency: 5 },
      ];
      await store.syncKeys(keys);
      const keyMap = new Map(keys.map((k) => [k.id, k]));

      let caughtError: any = null;
      try {
        await executeWithResilientFailover(
          store,
          keyMap,
          async () => new Response(JSON.stringify({ error: { message: "Rate limit" } }), {
            status: 429,
            headers: { "retry-after": "5" },
          }),
          3 // maxAttempts = 3, matching number of keys
        );
      } catch (err: any) {
        caughtError = err;
      }

      // Check what error was actually thrown:
      // Expected by API contract: 429 ALL_KEYS_RATE_LIMITED
      // Actual behavior in executor.ts: throws FailoverExhaustedError (503)
      expect(caughtError).not.toBeNull();
      expect(caughtError?.statusCode).toBe(429);
      expect(caughtError?.code).toBe("ALL_KEYS_RATE_LIMITED");
      // Documenting actual behavior:
      console.log("[Challenger 1 Observation] Error thrown when 3/3 keys return 429:", {
        name: caughtError?.name,
        code: caughtError?.code,
        statusCode: caughtError?.statusCode,
      });
    });
  });
});

