/**
 * Distributed LLM Key Management Types & Interfaces
 * Target: lib/llm/key-manager/types.ts
 */

export type KeyState =
  | 'ACTIVE'
  | 'RATE_LIMITED'
  | 'TRANSIENT_BACKOFF'
  | 'WARMUP'
  | 'EXHAUSTED'
  | 'DISABLED';

/** Backward-compatible alias for KeyState */
export type KeyStatus = KeyState;

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface KeyConfig {
  /** Unique key identifier (e.g. "openrouter-primary", "openrouter-backup-1") */
  id: string;
  /** Secret API key string ("sk-or-v1-...") */
  apiKey: string;
  /** Grouping identifier for shared billing balances / organizations */
  accountId?: string;
  /** Priority tier: 0 = Primary, 1 = Secondary, 2 = Emergency */
  tier: number;
  /** Configured relative throughput weight (e.g. 10 for 200 RPM, 3 for 50 RPM) */
  weight: number;
  /** Maximum allowable concurrent streaming requests */
  maxConcurrency: number;
  /** Optional list of supported models */
  models?: string[];
}

export interface KeyReservation {
  keyId: string;
  leaseToken: string;
}

export type KeyReservationResult = KeyReservation | null;

export interface KeyReleaseOutcome {
  /** HTTP status code (200, 401, 402, 429, 499, 500, 502, 503, 504, 0) */
  statusCode: number;
  /** Cooldown duration in milliseconds (used for 429 rate limit backoff) */
  cooldownMs?: number;
  /** Diagnostic error message or reason */
  errorMessage?: string;
}

export interface KeyMetrics {
  keyId: string;
  inFlightRequests: number;
  totalRequests: number;
  consecutiveFailures: number;
  consecutive429s: number;
  lastUsedAt: number;      // Epoch ms
  cooldownUntil: number;   // Epoch ms
  state: KeyState;
}

export interface KeyRuntimeState {
  id: string;
  accountId?: string;
  status: KeyStatus;
  circuitState: CircuitState;
  inFlightRequests: number;
  consecutiveFailures: number;
  consecutive429s: number;
  cooldownUntil: number;       // Epoch ms
  lastUsedAt: number;          // Epoch ms
  healthScore: number;         // EMA score [0.0 - 1.0]
  lastStatusCode: number | null;
  lastErrorMessage: string | null;
  canaryToken?: string;        // Lease token currently assigned to canary
  totalRequests: number;
}

export interface IKeyStore {
  /** Idempotently seeds keys, hashes, and account groups on service startup */
  syncKeys(keys: KeyConfig[]): Promise<void>;

  /**
   * Atomically reserves optimal key using WLIF-THALIC algorithm.
   * Self-prunes expired ZSET leases and excludes specified keys.
   */
  reserveKey(excludeKeyIds?: string[]): Promise<KeyReservationResult>;
  reserveKey(model: string, excludeKeyIds?: string[]): Promise<KeyReservationResult>;
  reserveKey(
    modelOrExclude?: string | string[],
    excludeKeyIds?: string[]
  ): Promise<KeyReservationResult>;

  /**
   * Phase 1: Immediately graduates WARMUP keys to ACTIVE upon receiving HTTP 200 headers (<500ms).
   * Returns true if graduated, false otherwise.
   */
  acknowledgeHandshake(keyId: string, leaseToken: string): Promise<boolean>;

  /**
   * Phase 2: Finalizes lease release on stream end, client abort (499), or error.
   * Guaranteed zero-leak ZSET slot reclamation.
   */
  releaseKey(
    keyId: string,
    leaseToken: string,
    outcome: KeyReleaseOutcome
  ): Promise<void>;
  releaseKey(
    keyId: string,
    leaseToken: string,
    statusCode: number,
    cooldownMs?: number,
    errorMessage?: string
  ): Promise<void>;
  releaseKey(
    keyId: string,
    leaseToken: string,
    outcomeOrStatus: KeyReleaseOutcome | number,
    cooldownMs?: number,
    errorMessage?: string
  ): Promise<void>;

  /** Retrieves operational metrics for a specific key */
  getKeyMetrics(keyId: string): Promise<KeyMetrics>;

  /** Retrieves the live active in-flight lease count (via authoritative ZCARD) */
  getActiveLeaseCount(keyId: string): Promise<number>;

  /** Retrieves all runtime states for monitoring and telemetry */
  getAllStates(): Promise<KeyRuntimeState[]>;

  /** Manually resets an exhausted or rate-limited key back to active */
  resetKeyToActive(keyId: string): Promise<void>;
}
