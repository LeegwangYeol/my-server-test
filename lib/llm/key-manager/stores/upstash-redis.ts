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
  memoryFallback?: MemoryKeyStore;
}

export interface UpstashRedisConfig {
  restUrl: string;
  restToken: string;
  timeoutMs?: number;
  breakerDurationMs?: number;
  memoryFallback?: MemoryKeyStore;
}

export class UpstashRedisKeyStore implements IKeyStore {
  private readonly restUrl: string;
  private readonly restToken: string;
  private readonly memoryFallback: MemoryKeyStore;
  private readonly timeoutMs: number;
  private readonly breakerDurationMs: number;

  // Storage circuit breaker state
  private redisConsecutiveFailures = 0;
  private storageBreakerOpenUntil = 0;

  constructor(
    urlOrConfig: string | UpstashRedisConfig,
    token?: string,
    options?: UpstashRedisOptions
  ) {
    if (typeof urlOrConfig === 'object') {
      this.restUrl = urlOrConfig.restUrl.replace(/\/$/, '');
      this.restToken = urlOrConfig.restToken;
      this.memoryFallback = urlOrConfig.memoryFallback ?? new MemoryKeyStore();
      this.timeoutMs = urlOrConfig.timeoutMs ?? 500;
      this.breakerDurationMs = urlOrConfig.breakerDurationMs ?? 30_000;
    } else {
      this.restUrl = urlOrConfig.replace(/\/$/, '');
      this.restToken = token ?? '';
      this.memoryFallback = options?.memoryFallback ?? new MemoryKeyStore();
      this.timeoutMs = options?.timeoutMs ?? 500;
      this.breakerDurationMs = options?.breakerDurationMs ?? 30_000;
    }
  }

  /**
   * Idempotent initialization: seeds keys, hashes, and account groups in Redis.
   */
  public async syncKeys(keys: KeyConfig[]): Promise<void> {
    await this.memoryFallback.syncKeys(keys);

    try {
      const pipeline: any[] = [];
      const keyIds = keys.map((k) => k.id);
      pipeline.push(['SADD', 'openrouter:keys:list', ...keyIds]);

      for (const k of keys) {
        pipeline.push([
          'HSETNX',
          `openrouter:key:${k.id}`,
          'tier',
          k.tier.toString(),
          'weight',
          k.weight.toString(),
          'max_concurrency',
          k.maxConcurrency.toString(),
          'account_id',
          k.accountId || '',
          'state',
          'ACTIVE',
          'total_requests',
          '0',
        ]);
        if (k.accountId) {
          pipeline.push(['SADD', `openrouter:account:${k.accountId}:keys`, k.id]);
        }
      }

      await this.execPipeline(pipeline);
    } catch (err: any) {
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
      // Client nonce for cryptographic entropy
      const clientNonce = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '';
      const result = await this.evalLua(
        RESERVE_KEY_LUA,
        ['openrouter:keys:list'],
        [5, 45_000, excludeKeyIds.join(','), clientNonce]
      );

      this.recordSuccess();

      if (!result || !result[0]) {
        return null;
      }

      const keyId = result[0];
      const leaseToken = result[1];

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
      return this.memoryFallback.releaseKey(keyId, leaseToken, statusCode, cooldown, errMsg);
    }

    try {
      await this.evalLua(
        RELEASE_KEY_LUA,
        [`openrouter:key:${keyId}`],
        [leaseToken, statusCode, cooldown, errMsg.slice(0, 200)]
      );
      this.recordSuccess();

      // Mirror release to memory fallback
      await this.memoryFallback.releaseKey(keyId, leaseToken, statusCode, cooldown, errMsg);
    } catch (err) {
      this.recordFailure(err);
      await this.memoryFallback.releaseKey(keyId, leaseToken, statusCode, cooldown, errMsg);
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
   */
  public async resetKeyToActive(keyId: string): Promise<void> {
    await this.memoryFallback.resetKeyToActive(keyId);

    if (this.isStorageBreakerOpen()) return;

    try {
      await this.execCommand(
        'HSET',
        `openrouter:key:${keyId}`,
        'state',
        'ACTIVE',
        'consecutive_429s',
        '0',
        'consecutive_failures',
        '0'
      );
      this.recordSuccess();
    } catch (err) {
      this.recordFailure(err);
    }
  }

  // --- Internal Fail-Open Circuit Breaker & HTTP Transport ---

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
    const res = await fetch(`${this.restUrl}/eval`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.restToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([script, keys.length, ...keys, ...args]),
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
    const res = await fetch(`${this.restUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.restToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(1000),
    });

    if (!res.ok) {
      throw new Error(`Upstash HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as any[];
    return data;
  }
}
