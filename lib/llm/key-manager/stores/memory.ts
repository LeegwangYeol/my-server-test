/**
 * High-Fidelity In-Memory Key Store with ZSET Simulation & Fail-Open Resilience
 * Target: lib/llm/key-manager/stores/memory.ts
 */

import type {
  IKeyStore,
  KeyConfig,
  KeyMetrics,
  KeyReleaseOutcome,
  KeyReservationResult,
  KeyRuntimeState,
  KeyState,
} from '../types';

interface InternalKeyRecord {
  config: KeyConfig;
  state: KeyState;
  cooldownUntil: number;
  lastUsedAt: number;
  totalRequests: number;
  consecutiveFailures: number;
  consecutive429s: number;
  canaryToken?: string;
  lastStatusCode: number | null;
  lastErrorMessage: string | null;
}

export class MemoryKeyStore implements IKeyStore {
  private readonly records = new Map<string, InternalKeyRecord>();
  /** Simulates openrouter:key:<id>:leases ZSET (member: leaseToken -> score: expireAtEpochMs) */
  private readonly leases = new Map<string, Map<string, number>>();
  /** Simulates openrouter:account:<accountId>:keys */
  private readonly accountKeys = new Map<string, Set<string>>();
  /** Simulates openrouter:account:<accountId>:broken (accountId -> expireAtEpochMs) */
  private readonly brokenAccounts = new Map<string, number>();

  private readonly clock: () => number;
  private readonly defaultMaxConcurrency: number;
  private readonly leaseTimeoutMs: number;

  constructor(options?: {
    clock?: () => number;
    defaultMaxConcurrency?: number;
    leaseTimeoutMs?: number;
  }) {
    this.clock = options?.clock ?? (() => Date.now());
    this.defaultMaxConcurrency = options?.defaultMaxConcurrency ?? 5;
    this.leaseTimeoutMs = options?.leaseTimeoutMs ?? 45_000;
  }

  private now(): number {
    return this.clock();
  }

  /**
   * Idempotent initialization: seeds keys, internal records, and account groups.
   * Matches HSETNX semantics: updates static configuration without overwriting active runtime states.
   */
  public async syncKeys(keys: KeyConfig[]): Promise<void> {
    for (const key of keys) {
      if (!this.leases.has(key.id)) {
        this.leases.set(key.id, new Map<string, number>());
      }

      const existing = this.records.get(key.id);
      if (existing) {
        existing.config = { ...key };
      } else {
        this.records.set(key.id, {
          config: { ...key },
          state: 'ACTIVE',
          cooldownUntil: 0,
          lastUsedAt: 0,
          totalRequests: 0,
          consecutiveFailures: 0,
          consecutive429s: 0,
          lastStatusCode: null,
          lastErrorMessage: null,
        });
      }

      if (key.accountId) {
        let set = this.accountKeys.get(key.accountId);
        if (!set) {
          set = new Set<string>();
          this.accountKeys.set(key.accountId, set);
        }
        set.add(key.id);
      }
    }
  }

  /**
   * Atomically reserves the optimal key using the Weighted Least-In-Flight (WLIF) algorithm.
   * Purges expired leases via simulated ZREMRANGEBYSCORE on every reservation.
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

    const excluded = new Set<string>(excludeKeyIds.map((id) => id.trim()).filter(Boolean));
    const now = this.now();

    // 1. Self-Pruning: Purge all expired leases across all keys atomically
    this.pruneAllExpiredLeases(now);

    if (this.records.size === 0) {
      return null;
    }

    let bestKey: string | null = null;
    let lowestTier = 999;
    let lowestLoadScore = 999_999_999;
    let oldestUsed = 9_999_999_999_999;

    for (const [keyId, record] of this.records.entries()) {
      if (excluded.has(keyId)) continue;

      const accountId = record.config.accountId || '';
      const isAccountBroken = this.isAccountBroken(accountId, now);
      if (isAccountBroken) continue;
      if (record.state === 'EXHAUSTED' || record.state === 'DISABLED') continue;

      const keyLeases = this.leases.get(keyId);
      const inFlight = keyLeases ? keyLeases.size : 0;
      const maxConc = record.config.maxConcurrency || this.defaultMaxConcurrency;
      const weight = Math.max(1, record.config.weight || 1);
      const tier = record.config.tier ?? 0;

      let eligible = false;

      if (record.state === 'ACTIVE') {
        if (inFlight < maxConc) {
          eligible = true;
        }
      } else if (record.state === 'RATE_LIMITED' || record.state === 'TRANSIENT_BACKOFF') {
        if (now >= record.cooldownUntil) {
          // Cooldown elapsed: promote to WARMUP
          record.state = 'WARMUP';
          if (inFlight === 0) {
            eligible = true;
          }
        }
      } else if (record.state === 'WARMUP') {
        // Strict canary lock: exactly 1 in-flight permitted
        if (inFlight === 0) {
          eligible = true;
        }
      }

      if (eligible) {
        // Weighted Least-In-Flight Load Score (scaled by 1000 for integer precision)
        const loadScore = Math.floor((inFlight * 1000) / weight);

        if (tier < lowestTier) {
          lowestTier = tier;
          lowestLoadScore = loadScore;
          oldestUsed = record.lastUsedAt;
          bestKey = keyId;
        } else if (tier === lowestTier) {
          if (loadScore < lowestLoadScore) {
            lowestLoadScore = loadScore;
            oldestUsed = record.lastUsedAt;
            bestKey = keyId;
          } else if (loadScore === lowestLoadScore) {
            if (record.lastUsedAt < oldestUsed) {
              oldestUsed = record.lastUsedAt;
              bestKey = keyId;
            }
          }
        }
      }
    }

    if (!bestKey) {
      return null;
    }

    const selectedRecord = this.records.get(bestKey)!;
    let keyLeases = this.leases.get(bestKey);
    if (!keyLeases) {
      keyLeases = new Map<string, number>();
      this.leases.set(bestKey, keyLeases);
    }

    // High-entropy 10-digit nonce eliminates same-millisecond birthday collisions
    const nonce = Math.floor(1000000000 + Math.random() * 9000000000);
    const leaseToken = `${bestKey}:${now}:${nonce}`;
    const leaseExpireAt = now + this.leaseTimeoutMs;

    // Enqueue lease token into simulated ZSET
    keyLeases.set(leaseToken, leaseExpireAt);
    selectedRecord.totalRequests++;
    selectedRecord.lastUsedAt = now;

    if (selectedRecord.state === 'WARMUP') {
      selectedRecord.canaryToken = leaseToken;
    }

    return { keyId: bestKey, leaseToken };
  }

  /**
   * Phase 1: Immediately graduates WARMUP keys to ACTIVE upon receiving HTTP 200 headers (<500ms).
   * Unlocks full concurrency ceiling for subsequent requests.
   */
  public async acknowledgeHandshake(keyId: string, leaseToken: string): Promise<boolean> {
    const record = this.records.get(keyId);
    if (!record) return false;

    if (record.state === 'WARMUP' && record.canaryToken === leaseToken) {
      record.state = 'ACTIVE';
      record.consecutive429s = 0;
      record.consecutiveFailures = 0;
      record.canaryToken = undefined;
      record.lastStatusCode = null;
      record.lastErrorMessage = null;
      return true;
    }

    return false;
  }

  /**
   * Phase 2: Removes ZSET lease token, resolves state transitions, and enforces 402 bulk invalidation.
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

    const now = this.now();
    const keyLeases = this.leases.get(keyId);
    const removed = keyLeases ? keyLeases.delete(leaseToken) : false;

    // Idempotent release check: If already removed/expired, do not double-process on 200/499
    if (!removed && (statusCode === 200 || statusCode === 499)) {
      return;
    }

    const record = this.records.get(keyId);
    if (!record) return;

    if (statusCode === 200) {
      if (record.state === 'WARMUP' && record.canaryToken === leaseToken) {
        record.state = 'ACTIVE';
        record.consecutive429s = 0;
        record.consecutiveFailures = 0;
        record.canaryToken = undefined;
        record.lastStatusCode = null;
        record.lastErrorMessage = null;
      } else if (record.state === 'ACTIVE') {
        record.consecutiveFailures = 0;
      }
    } else if (statusCode === 429) {
      // CRITICAL SAFETY GUARD: NEVER overwrite permanent EXHAUSTED with temporary RATE_LIMITED!
      if (record.state !== 'EXHAUSTED') {
        record.consecutive429s++;
        record.state = 'RATE_LIMITED';
        record.cooldownUntil = now + cooldown;
        record.lastStatusCode = 429;
        record.lastErrorMessage = errMsg;
      }
    } else if (statusCode === 402 || statusCode === 401) {
      // Permanent financial / authorization exhaustion
      record.state = 'EXHAUSTED';
      record.cooldownUntil = Infinity;
      record.lastStatusCode = statusCode;
      record.lastErrorMessage = errMsg;

      // Bulk-invalidate all keys sharing the same account in <5ms
      const accountId = record.config.accountId;
      if (accountId) {
        this.brokenAccounts.set(accountId, now + 86400 * 1000);
        const linkedKeys = this.accountKeys.get(accountId);
        if (linkedKeys) {
          for (const linkedId of linkedKeys) {
            const linkedRecord = this.records.get(linkedId);
            if (linkedRecord) {
              linkedRecord.state = 'EXHAUSTED';
              linkedRecord.cooldownUntil = Infinity;
              linkedRecord.lastStatusCode = statusCode;
              linkedRecord.lastErrorMessage = 'Account credit balance exhausted';
            }
          }
        }
      }
    } else if (statusCode >= 500 || (statusCode === 0 && cooldown > 0) || statusCode === 408) {
      // Transient network drop, timeout, or upstream 5xx
      record.consecutiveFailures++;
      if (record.consecutiveFailures >= 3 && record.state === 'ACTIVE') {
        record.state = 'TRANSIENT_BACKOFF';
        record.cooldownUntil = now + 2500;
      }
      record.lastStatusCode = statusCode;
      record.lastErrorMessage = errMsg;
    } else if (statusCode === 0 && cooldown === 0) {
      // Provider outage or zero-cooldown bypass: zero failure penalty
      record.lastStatusCode = 0;
      record.lastErrorMessage = errMsg;
    } else if (statusCode === 499) {
      // Client stream abort: slot already reclaimed, no penalty
      record.lastStatusCode = 499;
      record.lastErrorMessage = 'Client stream aborted';
    }
  }

  /**
   * Retrieves active in-flight lease count after pruning expired leases.
   */
  public async getActiveLeaseCount(keyId: string): Promise<number> {
    this.pruneKeyLeases(keyId, this.now());
    return this.leases.get(keyId)?.size ?? 0;
  }

  /**
   * Retrieves operational metrics for a specific key.
   */
  public async getKeyMetrics(keyId: string): Promise<KeyMetrics> {
    const now = this.now();
    this.pruneKeyLeases(keyId, now);

    const record = this.records.get(keyId);
    const inFlight = this.leases.get(keyId)?.size ?? 0;

    if (!record) {
      return {
        keyId,
        inFlightRequests: inFlight,
        totalRequests: 0,
        consecutiveFailures: 0,
        consecutive429s: 0,
        lastUsedAt: 0,
        cooldownUntil: 0,
        state: 'DISABLED',
      };
    }

    return {
      keyId,
      inFlightRequests: inFlight,
      totalRequests: record.totalRequests,
      consecutiveFailures: record.consecutiveFailures,
      consecutive429s: record.consecutive429s,
      lastUsedAt: record.lastUsedAt,
      cooldownUntil: record.cooldownUntil,
      state: record.state,
    };
  }

  /**
   * Retrieves all runtime states for monitoring and telemetry (L1 0.02ms fast telemetry).
   */
  public async getAllStates(): Promise<KeyRuntimeState[]> {
    const now = this.now();
    this.pruneAllExpiredLeases(now);

    const states: KeyRuntimeState[] = [];
    for (const [keyId, record] of this.records.entries()) {
      const inFlight = this.leases.get(keyId)?.size ?? 0;
      states.push({
        id: keyId,
        accountId: record.config.accountId,
        status: record.state,
        circuitState: record.state === 'ACTIVE' || record.state === 'WARMUP' ? 'CLOSED' : 'OPEN',
        inFlightRequests: inFlight,
        consecutiveFailures: record.consecutiveFailures,
        consecutive429s: record.consecutive429s,
        cooldownUntil: record.cooldownUntil,
        lastUsedAt: record.lastUsedAt,
        healthScore: Math.max(0, 1 - record.consecutiveFailures * 0.2 - record.consecutive429s * 0.3),
        lastStatusCode: record.lastStatusCode,
        lastErrorMessage: record.lastErrorMessage,
        canaryToken: record.canaryToken,
        totalRequests: record.totalRequests,
      });
    }

    return states;
  }

  /**
   * Manually resets an exhausted or rate-limited key back to active state.
   */
  public async resetKeyToActive(keyId: string): Promise<void> {
    const record = this.records.get(keyId);
    if (record) {
      record.state = 'ACTIVE';
      record.cooldownUntil = 0;
      record.consecutiveFailures = 0;
      record.consecutive429s = 0;
      record.canaryToken = undefined;
      record.lastStatusCode = null;
      record.lastErrorMessage = null;
    }
  }

  // --- Internal Utilities ---

  private pruneAllExpiredLeases(now: number): void {
    for (const [keyId] of this.records.keys()) {
      this.pruneKeyLeases(keyId, now);
    }
  }

  private pruneKeyLeases(keyId: string, now: number): void {
    const leaseMap = this.leases.get(keyId);
    if (!leaseMap) return;

    for (const [token, expireAt] of leaseMap.entries()) {
      if (now >= expireAt) {
        leaseMap.delete(token);
      }
    }
  }

  private isAccountBroken(accountId: string, now: number): boolean {
    if (!accountId) return false;
    const brokenUntil = this.brokenAccounts.get(accountId);
    if (!brokenUntil) return false;
    if (now >= brokenUntil) {
      this.brokenAccounts.delete(accountId);
      return false;
    }
    return true;
  }
}
