/**
 * WLIF Selection Engine & Resilient Health Cooldown Calculator
 * Target: lib/llm/key-manager/engine.ts
 */

import type { KeyConfig, KeyRuntimeState, KeyStatus } from './types';

export interface OpenRouterErrorPayload {
  error?: {
    message?: string;
    code?: number;
    metadata?: {
      provider_name?: string;
      model_slug?: string;
      raw?: string;
    };
  };
}

export interface KeyCandidate {
  config: KeyConfig;
  state: KeyRuntimeState;
  inFlight: number;
}

export interface SelectionResult {
  selectedKeyId: string;
  isCanary: boolean;
  loadScore: number;
  tier: number;
}

/**
 * Pure, deterministic WLIF-THALIC Selection Engine.
 * Evaluates candidate eligibility, priority tiers, weighted in-flight load,
 * EMA health scores, and LRU dispatch timestamps.
 */
export class WLIFSelectionEngine {
  public static selectOptimalKey(
    candidates: KeyCandidate[],
    excludeKeyIds: string[] = [],
    brokenAccountIds: Set<string> = new Set(),
    now: number = Date.now()
  ): SelectionResult | null {
    const excludeSet = new Set(excludeKeyIds.map((id) => id.trim()).filter(Boolean));

    // Step 1: Candidate Eligibility & Exclusion
    const eligible: Array<{
      candidate: KeyCandidate;
      isCanary: boolean;
    }> = [];

    for (const item of candidates) {
      const { config, state, inFlight } = item;

      // Rule 1.1: Exclude keys already tried in this request
      if (excludeSet.has(config.id)) continue;

      // Rule 1.2: Exclude disabled or permanently exhausted keys
      if (state.status === 'EXHAUSTED' || state.status === 'DISABLED') continue;

      // Rule 1.3: Exclude keys belonging to bankrupt/broken accounts
      if (config.accountId && brokenAccountIds.has(config.accountId)) continue;

      // Rule 1.4: State-based eligibility
      if (state.status === 'ACTIVE') {
        if (inFlight < config.maxConcurrency) {
          eligible.push({ candidate: item, isCanary: false });
        }
      } else if (state.status === 'WARMUP') {
        // Strict canary lock: exactly 0 in-flight requests permitted
        if (inFlight === 0) {
          eligible.push({ candidate: item, isCanary: true });
        }
      } else if (state.status === 'RATE_LIMITED' || state.status === 'TRANSIENT_BACKOFF') {
        // If cooldown has elapsed, key is eligible as a canary
        if (now >= state.cooldownUntil && inFlight === 0) {
          eligible.push({ candidate: item, isCanary: true });
        }
      }
    }

    if (eligible.length === 0) {
      return null;
    }

    // Step 2: Priority Tier Filtration (T* = min(T_i))
    let minTier = Infinity;
    for (const { candidate } of eligible) {
      if (candidate.config.tier < minTier) {
        minTier = candidate.config.tier;
      }
    }

    const tierCandidates = eligible.filter(
      ({ candidate }) => candidate.config.tier === minTier
    );

    // Step 3: Weighted Least-In-Flight (WLIF) Routing & Lexicographic Ranking
    // Minimize (LoadScore, -HealthBucket, LRU, KeyId)
    tierCandidates.sort((a, b) => {
      const weightA = Math.max(1, a.candidate.config.weight || 1);
      const weightB = Math.max(1, b.candidate.config.weight || 1);

      // 1. Primary: Lowest integer-scaled load score
      const loadScoreA = Math.floor((a.candidate.inFlight * 1000) / weightA);
      const loadScoreB = Math.floor((b.candidate.inFlight * 1000) / weightB);
      if (loadScoreA !== loadScoreB) {
        return loadScoreA - loadScoreB;
      }

      // 2. Secondary: Highest quantized EMA health score (bins of 0.1)
      const healthA = isNaN(a.candidate.state.healthScore) ? 1.0 : a.candidate.state.healthScore;
      const healthB = isNaN(b.candidate.state.healthScore) ? 1.0 : b.candidate.state.healthScore;
      const bucketA = Math.floor(10 * Math.max(0, Math.min(1, healthA)));
      const bucketB = Math.floor(10 * Math.max(0, Math.min(1, healthB)));
      if (bucketA !== bucketB) {
        return bucketB - bucketA; // Descending: higher health score preferred
      }

      // 3. Tertiary: Lowest lastUsedAt (LRU: maximize token bucket refill duration)
      const lastUsedA = a.candidate.state.lastUsedAt || 0;
      const lastUsedB = b.candidate.state.lastUsedAt || 0;
      if (lastUsedA !== lastUsedB) {
        return lastUsedA - lastUsedB; // Ascending: oldest used preferred
      }

      // 4. Deterministic tie-breaker
      return a.candidate.config.id.localeCompare(b.candidate.config.id);
    });

    const chosen = tierCandidates[0];
    const weight = Math.max(1, chosen.candidate.config.weight || 1);
    const finalLoadScore = Math.floor((chosen.candidate.inFlight * 1000) / weight);

    return {
      selectedKeyId: chosen.candidate.config.id,
      isCanary: chosen.isCanary,
      loadScore: finalLoadScore,
      tier: minTier,
    };
  }
}

/**
 * Canary Graduation State Machine.
 * Manages atomic transitions between ACTIVE, RATE_LIMITED, WARMUP, and EXHAUSTED.
 */
export class CanaryGraduationStateMachine {
  /**
   * Phase 1: Validates whether a key can graduate from WARMUP to ACTIVE.
   */
  public static canGraduate(
    currentState: KeyStatus,
    activeLeaseToken: string,
    authorizedCanaryToken?: string
  ): boolean {
    return (
      currentState === 'WARMUP' &&
      Boolean(authorizedCanaryToken) &&
      activeLeaseToken === authorizedCanaryToken
    );
  }

  /**
   * Applies the graduation mutation to runtime state.
   */
  public static graduate(state: KeyRuntimeState): void {
    state.status = 'ACTIVE';
    state.consecutive429s = 0;
    state.consecutiveFailures = 0;
    state.canaryToken = undefined;
    state.lastStatusCode = 200;
    state.lastErrorMessage = null;
  }
}

/**
 * Health and Cooldown Engine.
 * Defends against NaN injection, parses RFC 9110 / ISO 8601 timestamps,
 * discriminates upstream provider outages, and calculates backoff with full jitter.
 */
export class HealthAndCooldownEngine {
  public static readonly ALPHA_DECAY = 0.85;
  public static readonly BASE_BACKOFF_MS = 2_000;
  public static readonly MAX_BACKOFF_MS = 60_000;

  /**
   * Updates health score using Exponential Moving Average (EMA).
   */
  public static updateHealthScore(
    current: number,
    outcome: 'SUCCESS' | 'RATE_LIMIT' | 'SERVER_ERROR' | 'TIMEOUT'
  ): number {
    let score = 1.0;
    switch (outcome) {
      case 'SUCCESS':
        score = 1.0;
        break;
      case 'RATE_LIMIT':
        score = 0.2;
        break;
      case 'SERVER_ERROR':
        score = 0.1;
        break;
      case 'TIMEOUT':
        score = 0.0;
        break;
    }
    const safeCurrent = isNaN(current) ? 1.0 : Math.max(0, Math.min(1, current));
    return Number((safeCurrent * this.ALPHA_DECAY + score * (1 - this.ALPHA_DECAY)).toFixed(4));
  }

  /**
   * Distinguishes between key rate limits and upstream provider/model outages.
   */
  public static isUpstreamProviderOutage(
    payload?: OpenRouterErrorPayload
  ): { isOutage: boolean; provider?: string } {
    if (payload?.error?.metadata?.provider_name) {
      return { isOutage: true, provider: payload.error.metadata.provider_name };
    }
    const msg = (payload?.error?.message || '').toLowerCase();
    if (
      msg.includes('provider returned') ||
      msg.includes('upstream') ||
      msg.includes('overloaded') ||
      msg.includes('provider unavailable') ||
      msg.includes('model is currently overloaded')
    ) {
      return { isOutage: true, provider: 'UpstreamProvider' };
    }
    return { isOutage: false };
  }

  /**
   * Evaluates response headers to determine accurate 429 cooldown with jitter buffer.
   * Fully protected against NaN, malformed Date headers, and ISO 8601 strings.
   */
  public static calculate429Cooldown(
    headers: Headers | Record<string, string | string[] | undefined>,
    consecutive429s: number,
    nowMs: number = Date.now()
  ): number {
    const getHeader = (name: string): string | null => {
      if (!headers) return null;
      if (typeof (headers as Headers).get === 'function') {
        return (headers as Headers).get(name);
      }
      const record = headers as Record<string, string | string[] | undefined>;
      const lowerName = name.toLowerCase();
      let val = record[name] ?? record[lowerName];
      if (val === undefined) {
        const matchingKey = Object.keys(record).find((k) => k.toLowerCase() === lowerName);
        if (matchingKey) {
          val = record[matchingKey];
        }
      }
      if (Array.isArray(val)) return val[0] ?? null;
      return val ?? null;
    };

    const now = nowMs;

    // 1. Check standard 'retry-after' header (delta-seconds or RFC 9110 HTTP-Date)
    const retryAfter = getHeader('retry-after');
    if (retryAfter) {
      const trimmed = retryAfter.trim();
      // Handle pure numeric delta-seconds
      if (/^\d+$/.test(trimmed)) {
        const deltaSec = parseInt(trimmed, 10);
        if (!isNaN(deltaSec) && deltaSec >= 0) {
          return Math.max(1000, deltaSec * 1000 + this.getJitterMs(500, 1500));
        }
      }
      // Handle RFC 9110 HTTP-Date
      const parsedDate = Date.parse(trimmed);
      if (!isNaN(parsedDate)) {
        const serverDateStr = getHeader('date');
        let skew = 0;
        if (serverDateStr) {
          const parsedServerDate = Date.parse(serverDateStr);
          if (!isNaN(parsedServerDate)) {
            skew = parsedServerDate - now;
          }
        }
        const diffMs = parsedDate - (now + skew);
        if (!isNaN(diffMs) && diffMs > 0) {
          return Math.max(1000, diffMs + this.getJitterMs(500, 1500));
        }
      }
    }

    // 2. Check 'x-ratelimit-reset' (ISO 8601, Epoch seconds, or Epoch ms)
    const resetHeader = getHeader('x-ratelimit-reset');
    if (resetHeader) {
      const trimmed = resetHeader.trim();

      // Check for ISO 8601 string first (prevents parseFloat evaluating "2026-..." as 2026)
      const isoParsed = Date.parse(trimmed);
      if (!isNaN(isoParsed) && isNaN(Number(trimmed))) {
        const diffMs = isoParsed - now;
        return Math.max(1000, (diffMs > 0 ? diffMs : 0) + this.getJitterMs(500, 1500));
      }

      // Numeric parsing
      const resetVal = parseFloat(trimmed);
      if (!isNaN(resetVal) && resetVal >= 0) {
        let diffMs = 0;
        if (resetVal < 100_000) {
          // Relative seconds
          diffMs = resetVal * 1000;
        } else if (resetVal < 10_000_000_000) {
          // Unix epoch seconds
          diffMs = resetVal * 1000 - now;
        } else {
          // Unix epoch milliseconds
          diffMs = resetVal - now;
        }
        if (!isNaN(diffMs) && diffMs > 0) {
          return Math.max(1000, diffMs + this.getJitterMs(500, 1500));
        }
      }
    }

    // 3. Fallback: Exponential Backoff with Full Jitter
    const safeConsecutive = isNaN(consecutive429s) ? 1 : Math.max(1, Math.min(consecutive429s, 5));
    const expCap = Math.min(this.MAX_BACKOFF_MS, this.BASE_BACKOFF_MS * Math.pow(2, safeConsecutive));
    const cooldown = Math.floor(Math.random() * expCap) + 500;

    return isNaN(cooldown) ? 2000 : Math.max(1000, cooldown);
  }

  public static getJitterMs(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
