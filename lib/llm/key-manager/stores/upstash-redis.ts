/**
 * Upstash Redis REST Key Store with Inline Lua Execution & Fail-Open Resilience
 * Target: lib/llm/key-manager/stores/upstash-redis.ts
 */

import type {
  IKeyStore,
  KeyConfig,
  KeyMetrics,
  KeyReleaseOutcome,
  KeyReservationResult,
  KeyRuntimeState,
} from '../types';
import { MemoryKeyStore } from './memory';
import {
  RESERVE_KEY_LUA,
  ACKNOWLEDGE_HANDSHAKE_LUA,
  RELEASE_KEY_LUA,
} from '../lua/scripts';

export interface UpstashRedisOptions {
  timeoutMs?: number;
  breakerDurationMs?: number;
  defaultMaxConcurrency?: number;
  memoryFallback?: MemoryKeyStore;
}

export interface UpstashRedisConfig {
  restUrl: string;
  restToken: string;
  timeoutMs?: number;
  breakerDurationMs?: number;
  defaultMaxConcurrency?: number;
  memoryFallback?: MemoryKeyStore;
}

export class UpstashRedisKeyStore implements IKeyStore {
  private readonly restUrl: string;
  private readonly restToken: string;
  private readonly memoryFallback: MemoryKeyStore;
  private readonly timeoutMs: number;
  private readonly breakerDurationMs: number;
  private readonly defaultMaxConcurrency: number;

  // Storage circuit breaker state
  private redisConsecutiveFailures = 0;
  private storageBreakerOpenUntil = 0;
  private inflightExhaustionFlush: Promise<void> | null = null;
  /**
   * Permanent 402/401/403 exhaustions observed while Redis was unreachable / breaker-open,
   * flushed back to Redis upon recovery so bankrupt keys are never resurrected.
   */
  private readonly pendingPermanentExhaustions = new Map<
    string,
    { statusCode: number; errMsg: string }
  >();

  constructor(
    urlOrConfig: string | UpstashRedisConfig,
    token?: string,
    options?: UpstashRedisOptions
  ) {
    if (typeof urlOrConfig === 'object') {
      const defConc =
        typeof urlOrConfig.defaultMaxConcurrency === 'number' &&
        Number.isFinite(urlOrConfig.defaultMaxConcurrency) &&
        urlOrConfig.defaultMaxConcurrency >= 1
          ? Math.floor(urlOrConfig.defaultMaxConcurrency)
          : 5;
      this.restUrl = urlOrConfig.restUrl.replace(/\/$/, '');
      this.restToken = urlOrConfig.restToken;
      this.defaultMaxConcurrency = defConc;
      this.memoryFallback =
        urlOrConfig.memoryFallback ?? new MemoryKeyStore({ defaultMaxConcurrency: defConc });
      this.timeoutMs = urlOrConfig.timeoutMs ?? 500;
      this.breakerDurationMs = urlOrConfig.breakerDurationMs ?? 30_000;
    } else {
      const defConc =
        typeof options?.defaultMaxConcurrency === 'number' &&
        Number.isFinite(options.defaultMaxConcurrency) &&
        options.defaultMaxConcurrency >= 1
          ? Math.floor(options.defaultMaxConcurrency)
          : 5;
      this.restUrl = urlOrConfig.replace(/\/$/, '');
      this.restToken = token ?? '';
      this.defaultMaxConcurrency = defConc;
      this.memoryFallback =
        options?.memoryFallback ?? new MemoryKeyStore({ defaultMaxConcurrency: defConc });
      this.timeoutMs = options?.timeoutMs ?? 500;
      this.breakerDurationMs = options?.breakerDurationMs ?? 30_000;
    }
  }

  /**
   * Idempotent initialization: seeds keys, hashes, and account groups in Redis.
   */
  public async syncKeys(keys: KeyConfig[]): Promise<void> {
    const prevStates = await this.memoryFallback.getAllStates();
    const prevAccountByKey = new Map<string, string | undefined>(
      prevStates.map((s) => [s.id, s.accountId])
    );
    const nextIds = new Set(keys.map((k) => k.id));

    await this.memoryFallback.syncKeys(keys);

    if (this.isStorageBreakerOpen()) {
      return;
    }

    try {
      const pipeline: any[] = [['DEL', 'openrouter:keys:list']];
      const keyIds = keys.map((k) => k.id);
      if (keyIds.length > 0) {
        pipeline.push(['SADD', 'openrouter:keys:list', ...keyIds]);
      }

      for (const [prevId, prevAcc] of prevAccountByKey.entries()) {
        if (prevAcc && !nextIds.has(prevId)) {
          pipeline.push(['SREM', `openrouter:account:${prevAcc}:keys`, prevId]);
        }
      }

      for (const k of keys) {
        const prevAcc = prevAccountByKey.get(k.id);
        if (prevAcc && prevAcc !== k.accountId) {
          pipeline.push(['SREM', `openrouter:account:${prevAcc}:keys`, k.id]);
        }
        const hashKey = `openrouter:key:${k.id}`;
        pipeline.push([
          'HSET',
          hashKey,
          'tier',
          k.tier.toString(),
          'weight',
          k.weight.toString(),
          'max_concurrency',
          k.maxConcurrency.toString(),
          'account_id',
          k.accountId || '',
        ]);
        pipeline.push(['HSETNX', hashKey, 'state', 'ACTIVE']);
        pipeline.push(['HSETNX', hashKey, 'total_requests', '0']);
        if (k.accountId) {
          pipeline.push(['SADD', `openrouter:account:${k.accountId}:keys`, k.id]);
        }
      }

      await this.execPipeline(pipeline);
      this.recordSuccess();
    } catch (err: any) {
      this.recordFailure(err);
      console.warn('[KeyStore:Upstash] Redis syncKeys degraded to in-memory:', err?.message || err);
    }
  }

  /**
   * Atomically reserves the optimal key using RESERVE_KEY_LUA in Redis.
   * On failure or breaker-open, fails open to MemoryKeyStore.
   */
  public async reserveKey(
    modelOrExclude?: string | string[],
    maybeExclude?: string[]
  ): Promise<KeyReservationResult> {
    let excludeKeyIds: string[] = [];
    if (Array.isArray(modelOrExclude)) {
      excludeKeyIds = modelOrExclude;
    } else if (Array.isArray(maybeExclude)) {
      excludeKeyIds = maybeExclude;
    }

    if (this.isStorageBreakerOpen()) {
      return this.memoryFallback.reserveKey(modelOrExclude, maybeExclude);
    }

    try {
      await this.flushPendingExhaustionsToRedis();

      // Client nonce for cryptographic entropy
      const clientNonce = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '';
      const result = await this.evalLua(
        RESERVE_KEY_LUA,
        ['openrouter:keys:list'],
        [this.defaultMaxConcurrency, 45_000, excludeKeyIds.join(','), clientNonce]
      );

      this.recordSuccess();

      if (!result || !result[0]) {
        return null;
      }

      const keyId = result[0];
      const leaseToken = result[1];

      // Mirror reservation into L1 memory store so WARMUP graduation, getAllStates(),
      // and mid-stream breaker fail-open stay synchronized with Redis ZSET leases.
      this.memoryFallback.mirrorReservation(keyId, leaseToken);

      return { keyId, leaseToken };
    } catch (err) {
      this.recordFailure(err);
      return this.memoryFallback.reserveKey(modelOrExclude, maybeExclude);
    }
  }

  /**
   * Phase 1: Immediately graduates WARMUP keys to ACTIVE upon receiving HTTP 200 headers (<500ms).
   */
  public async acknowledgeHandshake(keyId: string, leaseToken: string): Promise<boolean> {
    if (this.isStorageBreakerOpen()) {
      return this.memoryFallback.acknowledgeHandshake(keyId, leaseToken);
    }

    try {
      const res = await this.evalLua(
        ACKNOWLEDGE_HANDSHAKE_LUA,
        [`openrouter:key:${keyId}`],
        [leaseToken]
      );
      this.recordSuccess();

      // Mirror graduation to memory fallback
      await this.memoryFallback.acknowledgeHandshake(keyId, leaseToken);
      return res === 'GRADUATED_ACTIVE';
    } catch (err) {
      this.recordFailure(err);
      return this.memoryFallback.acknowledgeHandshake(keyId, leaseToken);
    }
  }

  /**
   * Phase 2: Finalizes lease release on stream end, client abort (499), or error.
   */
  public async releaseKey(
    keyId: string,
    leaseToken: string,
    outcomeOrStatus: KeyReleaseOutcome | number,
    cooldownMs?: number,
    errorMessage?: string
  ): Promise<void> {
    let statusCode: number;
    let cooldown: number;
    let errMsg: string;

    if (typeof outcomeOrStatus === 'object') {
      statusCode = outcomeOrStatus.statusCode;
      cooldown = outcomeOrStatus.cooldownMs ?? 0;
      errMsg = outcomeOrStatus.errorMessage ?? '';
    } else {
      statusCode = outcomeOrStatus;
      cooldown = cooldownMs ?? 0;
      errMsg = errorMessage ?? '';
    }

    if (this.isStorageBreakerOpen()) {
      await this.memoryFallback.releaseKey(keyId, leaseToken, statusCode, cooldown, errMsg);
      await this.queuePermanentExhaustionIfNeeded(keyId, statusCode, errMsg);
      return;
    }

    try {
      const safeStatus =
        typeof statusCode === 'number' && Number.isFinite(statusCode)
          ? Math.trunc(statusCode)
          : 0;
      const safeCooldown =
        typeof cooldown === 'number' && Number.isFinite(cooldown) && cooldown >= 0
          ? Math.floor(cooldown)
          : 0;
      await this.evalLua(
        RELEASE_KEY_LUA,
        [`openrouter:key:${keyId}`],
        [leaseToken, safeStatus, safeCooldown, errMsg.slice(0, 200)]
      );
      this.recordSuccess();

      // Mirror release to memory fallback
      await this.memoryFallback.releaseKey(keyId, leaseToken, statusCode, cooldown, errMsg);
    } catch (err) {
      this.recordFailure(err);
      await this.memoryFallback.releaseKey(keyId, leaseToken, statusCode, cooldown, errMsg);
      await this.queuePermanentExhaustionIfNeeded(keyId, statusCode, errMsg);
    }
  }

  /**
   * Retrieves live active in-flight lease count from Redis via ZCARD.
   */
  public async getActiveLeaseCount(keyId: string): Promise<number> {
    if (this.isStorageBreakerOpen()) {
      return this.memoryFallback.getActiveLeaseCount(keyId);
    }

    try {
      const now = Date.now();
      const zsetKey = `openrouter:key:${keyId}:leases`;
      const pipeline = [
        ['ZREMRANGEBYSCORE', zsetKey, '-inf', now.toString()],
        ['ZCARD', zsetKey],
      ];
      const res = await this.execPipeline(pipeline);
      this.recordSuccess();
      return typeof res[1]?.result === 'number' ? res[1].result : 0;
    } catch (err) {
      this.recordFailure(err);
      return this.memoryFallback.getActiveLeaseCount(keyId);
    }
  }

  /**
   * Retrieves operational metrics for a key.
   */
  public async getKeyMetrics(keyId: string): Promise<KeyMetrics> {
    if (this.isStorageBreakerOpen()) {
      return this.memoryFallback.getKeyMetrics(keyId);
    }

    try {
      const now = Date.now();
      const hashKey = `openrouter:key:${keyId}`;
      const zsetKey = `openrouter:key:${keyId}:leases`;

      const pipeline = [
        ['ZREMRANGEBYSCORE', zsetKey, '-inf', now.toString()],
        ['ZCARD', zsetKey],
        ['HMGET', hashKey, 'state', 'total_requests', 'consecutive_failures', 'consecutive_429s', 'last_used_at', 'cooldown_until'],
      ];

      const res = await this.execPipeline(pipeline);
      this.recordSuccess();

      const inFlight = typeof res[1]?.result === 'number' ? res[1].result : 0;
      const hmData = res[2]?.result || [];

      return {
        keyId,
        inFlightRequests: inFlight,
        totalRequests: parseInt(hmData[1] || '0', 10),
        consecutiveFailures: parseInt(hmData[2] || '0', 10),
        consecutive429s: parseInt(hmData[3] || '0', 10),
        lastUsedAt: parseInt(hmData[4] || '0', 10),
        cooldownUntil: parseInt(hmData[5] || '0', 10),
        state: hmData[0] || 'ACTIVE',
      };
    } catch (err) {
      this.recordFailure(err);
      return this.memoryFallback.getKeyMetrics(keyId);
    }
  }

  /**
   * Fast telemetry (0.02ms) via local memory fallback state.
   */
  public async getAllStates(): Promise<KeyRuntimeState[]> {
    return this.memoryFallback.getAllStates();
  }

  /**
   * Manually resets an exhausted or rate-limited key back to active.
   * Restores sibling keys in the same account that were bulk-exhausted by 402
   * while preserving 401/403 key-scoped revocations.
   */
  public async resetKeyToActive(keyId: string): Promise<void> {
    const statesBefore = await this.memoryFallback.getAllStates();
    const targetBefore = statesBefore.find((s) => s.id === keyId);
    if (targetBefore?.status === 'DISABLED') {
      return;
    }
    const accountId = targetBefore?.accountId;
    const sibling402Ids: string[] = [];
    this.pendingPermanentExhaustions.delete(keyId);
    if (accountId) {
      for (const st of statesBefore) {
        if (st.accountId === accountId) {
          const pending = this.pendingPermanentExhaustions.get(st.id);
          if (!pending || pending.statusCode === 402) {
            this.pendingPermanentExhaustions.delete(st.id);
          }
          if (
            st.id !== keyId &&
            st.status === 'EXHAUSTED' &&
            st.lastStatusCode === 402
          ) {
            sibling402Ids.push(st.id);
          }
        }
      }
    }
    await this.memoryFallback.resetKeyToActive(keyId);

    if (this.isStorageBreakerOpen()) return;

    try {
      await this.flushPendingExhaustionsToRedis();
      const pipeline: any[][] = [];
      for (const targetId of [keyId, ...sibling402Ids]) {
        const hashKey = `openrouter:key:${targetId}`;
        pipeline.push([
          'HSET',
          hashKey,
          'state',
          'ACTIVE',
          'cooldown_until',
          '0',
          'consecutive_429s',
          '0',
          'consecutive_failures',
          '0',
        ]);
        pipeline.push([
          'HDEL',
          hashKey,
          'canary_token',
          'last_error_code',
          'last_error_message',
        ]);
      }
      if (accountId) {
        pipeline.push(['DEL', `openrouter:account:${accountId}:broken`]);
      }
      await this.execPipeline(pipeline);
      this.recordSuccess();
    } catch (err) {
      this.recordFailure(err);
    }
  }

  // --- Internal Fail-Open Circuit Breaker & HTTP Transport ---

  private async queuePermanentExhaustionIfNeeded(
    keyId: string,
    statusCode: number,
    errMsg: string
  ): Promise<void> {
    if (statusCode !== 402 && statusCode !== 401 && statusCode !== 403) {
      return;
    }
    if (statusCode === 402) {
      const existingPending = this.pendingPermanentExhaustions.get(keyId);
      if (
        existingPending &&
        (existingPending.statusCode === 401 || existingPending.statusCode === 403)
      ) {
        return;
      }
      const states = await this.memoryFallback.getAllStates();
      const memState = states.find((s) => s.id === keyId);
      if (
        memState?.status === 'EXHAUSTED' &&
        (memState.lastStatusCode === 401 || memState.lastStatusCode === 403)
      ) {
        return;
      }
    }
    this.pendingPermanentExhaustions.set(keyId, {
      statusCode,
      errMsg: errMsg.slice(0, 200),
    });
  }

  private async flushPendingExhaustionsToRedis(): Promise<void> {
    if (this.pendingPermanentExhaustions.size === 0) return;
    if (this.inflightExhaustionFlush) {
      return this.inflightExhaustionFlush;
    }

    const runFlush = (async () => {
      const snapshot = new Map(this.pendingPermanentExhaustions);
      if (snapshot.size === 0) return;

      const states = await this.memoryFallback.getAllStates();
      const stateMap = new Map(states.map((s) => [s.id, s]));
      const pipeline: any[][] = [];

      for (const [keyId, info] of snapshot.entries()) {
        const st = stateMap.get(keyId);
        if (st && st.status !== 'EXHAUSTED') {
          continue;
        }
        const hashKey = `openrouter:key:${keyId}`;
        pipeline.push([
          'HSET',
          hashKey,
          'state',
          'EXHAUSTED',
          'last_error_code',
          String(info.statusCode),
          'last_error_message',
          info.errMsg,
        ]);
        pipeline.push(['HDEL', hashKey, 'canary_token']);

        if (info.statusCode === 402 && st?.accountId) {
          pipeline.push([
            'SET',
            `openrouter:account:${st.accountId}:broken`,
            '1',
            'EX',
            '86400',
          ]);
          for (const sib of states) {
            if (sib.accountId === st.accountId && sib.id !== keyId) {
              if (
                sib.status === 'DISABLED' ||
                (sib.status === 'EXHAUSTED' &&
                  (sib.lastStatusCode === 401 || sib.lastStatusCode === 403))
              ) {
                continue;
              }
              const sibHash = `openrouter:key:${sib.id}`;
              pipeline.push([
                'HSET',
                sibHash,
                'state',
                'EXHAUSTED',
                'last_error_code',
                '402',
                'last_error_message',
                'Account credit balance exhausted',
              ]);
              pipeline.push(['HDEL', sibHash, 'canary_token']);
            }
          }
        }
      }

      if (pipeline.length > 0) {
        await this.execPipeline(pipeline);
      }

      // Only delete entries whose exact reference was included in this snapshot,
      // preserving any new permanent revocations/402s queued concurrently mid-flight.
      for (const [keyId, flushedInfo] of snapshot.entries()) {
        if (this.pendingPermanentExhaustions.get(keyId) === flushedInfo) {
          this.pendingPermanentExhaustions.delete(keyId);
        }
      }
    })().finally(() => {
      if (this.inflightExhaustionFlush === runFlush) {
        this.inflightExhaustionFlush = null;
      }
    });

    this.inflightExhaustionFlush = runFlush;
    return runFlush;
  }

  private isStorageBreakerOpen(): boolean {
    return Date.now() < this.storageBreakerOpenUntil;
  }

  private recordSuccess(): void {
    this.redisConsecutiveFailures = 0;
  }

  private recordFailure(err: any): void {
    this.redisConsecutiveFailures++;
    console.warn(`[KeyStore:Upstash] Request failed (${this.redisConsecutiveFailures}/3):`, err?.message || err);
    if (this.redisConsecutiveFailures >= 3) {
      this.storageBreakerOpenUntil = Date.now() + this.breakerDurationMs;
      console.error(
        `[KeyStore:StorageBreaker] TRIPPED OPEN. Failing open to MemoryKeyStore for ${this.breakerDurationMs / 1000}s.`
      );
    }
  }

  private async evalLua(script: string, keys: string[], args: any[]): Promise<any> {
    const safeArgs = args.map((a) => {
      if (a === null || a === undefined) return '';
      if (typeof a === 'number') return Number.isFinite(a) ? a : 0;
      return a;
    });
    const res = await fetch(`${this.restUrl}/eval`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.restToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([script, keys.length, ...keys, ...safeArgs]),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Upstash HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as { result?: any; error?: string };
    if (data.error) {
      throw new Error(`Upstash Lua Error: ${data.error}`);
    }
    return data.result;
  }

  private async execCommand(...cmd: any[]): Promise<any> {
    const res = await fetch(`${this.restUrl}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.restToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Upstash HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as { result?: any; error?: string };
    if (data.error) {
      throw new Error(`Upstash Command Error: ${data.error}`);
    }
    return data.result;
  }

  private async execPipeline(commands: any[][]): Promise<any[]> {
    const pipelineTimeoutMs = Math.min(1000, Math.max(25, this.timeoutMs * 2));
    const res = await fetch(`${this.restUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.restToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(pipelineTimeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Upstash HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as any[];
    if (Array.isArray(data)) {
      const cmdErr = data.find((entry) => entry && typeof entry === 'object' && entry.error);
      if (cmdErr) {
        throw new Error(`Upstash Pipeline Command Error: ${cmdErr.error}`);
      }
    }
    return data;
  }
}
