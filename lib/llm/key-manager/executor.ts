/**
 * Multi-Attempt Resilient Failover Executor with Exclusion Tracking
 * Target: lib/llm/key-manager/executor.ts
 */

import type { IKeyStore, KeyConfig } from './types';
import { HealthAndCooldownEngine, type OpenRouterErrorPayload } from './engine';

export interface HandshakeResult {
  response: Response;
  keyId: string;
  leaseToken: string;
}

export class KeyManagerError extends Error {
  public readonly code?: string;

  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly retryAfterSeconds?: number,
    code?: string
  ) {
    super(message);
    this.name = 'KeyManagerError';
    this.code = code;
  }
}

export class AllKeysRateLimitedError extends KeyManagerError {
  public override readonly code = 'ALL_KEYS_RATE_LIMITED';

  constructor(retryAfterSeconds: number = 5) {
    super(
      'ALL_KEYS_RATE_LIMITED: All API channels are currently busy.',
      429,
      retryAfterSeconds,
      'ALL_KEYS_RATE_LIMITED'
    );
    this.name = 'AllKeysRateLimitedError';
  }
}

export class AllAccountsExhaustedError extends KeyManagerError {
  public override readonly code = 'ALL_ACCOUNTS_EXHAUSTED';

  constructor() {
    super(
      'ALL_ACCOUNTS_EXHAUSTED: Service temporarily unavailable due to upstream provider credit exhaustion.',
      503,
      undefined,
      'ALL_ACCOUNTS_EXHAUSTED'
    );
    this.name = 'AllAccountsExhaustedError';
  }
}

export class AllKeysUnavailableError extends AllKeysRateLimitedError {
  constructor(retryAfterSeconds: number = 5) {
    super(retryAfterSeconds);
    this.name = 'AllKeysUnavailableError';
  }
}

export class UpstreamProviderOutageError extends KeyManagerError {
  public override readonly code = 'UPSTREAM_MODEL_OUTAGE';

  constructor(public readonly provider: string) {
    super(
      `UPSTREAM_MODEL_OUTAGE: ${provider} is experiencing an outage.`,
      503,
      undefined,
      'UPSTREAM_MODEL_OUTAGE'
    );
    this.name = 'UpstreamProviderOutageError';
  }
}

export class FailoverExhaustedError extends KeyManagerError {
  public override readonly code = 'FAILOVER_EXHAUSTED';

  constructor(public readonly attemptedKeyIds: string[]) {
    super(
      `FAILOVER_EXHAUSTED: Handshake failed across keys: [${attemptedKeyIds.join(', ')}]`,
      503,
      undefined,
      'FAILOVER_EXHAUSTED'
    );
    this.name = 'FailoverExhaustedError';
  }
}

/**
 * Creates an attempt signal combining an attempt timeout with the client's abort signal.
 * Ensures proper cleanup of timers and event listeners to prevent resource leaks.
 */
function createAttemptSignal(
  timeoutMs: number,
  clientSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error('ATTEMPT_TIMEOUT'));
  }, timeoutMs);

  const onClientAbort = () => {
    controller.abort(clientSignal?.reason || new Error('CLIENT_ABORTED'));
  };

  if (clientSignal) {
    if (clientSignal.aborted) {
      controller.abort(clientSignal.reason);
    } else {
      clientSignal.addEventListener('abort', onClientAbort, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timeoutId);
    if (clientSignal) {
      clientSignal.removeEventListener('abort', onClientAbort);
    }
  };

  return { signal: controller.signal, cleanup };
}

/**
 * Executes an HTTP handshake across available API keys with up to `maxAttempts` retries.
 * 
 * Invariants:
 * 1. Exclusion Tracking: Every attempted key is added to `attemptedKeyIds` and excluded
 *    from subsequent reservations, preventing self-inflicted 429 penalties.
 * 2. Provider Outage Discrimination: Upstream provider outages (e.g., Anthropic/OpenAI)
 *    release the key with status 0 / cooldown 0 and trip model fallback without penalizing the key.
 * 3. Fast-Break: Keys in bankrupt accounts are immediately bypassed in <5ms.
 * 4. Phase-1 Canary Graduation: HTTP 200 OK immediately calls acknowledgeHandshake(<500ms).
 */
export async function executeWithResilientFailover(
  keyStore: IKeyStore,
  keyConfigMap: Map<string, KeyConfig>,
  requestFactory: (apiKey: string, signal?: AbortSignal) => Promise<Response>,
  maxAttempts: number = 3,
  clientSignal?: AbortSignal
): Promise<HandshakeResult> {
  const attemptedKeyIds: string[] = [];
  const brokenAccountIds = new Set<string>();
  let attempt = 0;
  let lastStatusCode: number | null = null;

  while (attempt < maxAttempts) {
    if (clientSignal?.aborted) {
      throw new KeyManagerError(
        'CLIENT_ABORTED: Client disconnected before handshake completed.',
        499,
        undefined,
        'CLIENT_ABORTED'
      );
    }

    attempt++;

    // Step 1: Reserve next eligible key, strictly excluding previously attempted keys
    const reservation = await keyStore.reserveKey(attemptedKeyIds);
    if (!reservation) {
      const allStates = await keyStore.getAllStates().catch(() => []);
      if (allStates.length > 0 && allStates.every((s) => s.status === 'EXHAUSTED')) {
        throw new AllAccountsExhaustedError();
      }
      throw new AllKeysRateLimitedError(5);
    }

    const { keyId, leaseToken } = reservation;
    attemptedKeyIds.push(keyId);

    const config = keyConfigMap.get(keyId);
    if (!config) {
      await keyStore.releaseKey(keyId, leaseToken, 500, 0, 'Missing key configuration');
      continue;
    }

    // Step 2: Fast-break: If key belongs to an account confirmed exhausted, release and bypass
    if (config.accountId && brokenAccountIds.has(config.accountId)) {
      lastStatusCode = 402;
      await keyStore.releaseKey(
        keyId,
        leaseToken,
        402,
        Infinity,
        'Shared account balance exhausted'
      );
      continue;
    }

    // Step 3: Enforce strict 6-second execution budget per attempt
    const { signal: attemptSignal, cleanup: cleanupSignal } = createAttemptSignal(
      6000,
      clientSignal
    );

    try {
      const response = await requestFactory(config.apiKey, attemptSignal);
      cleanupSignal();

      // --- CASE 1: SUCCESS (200 OK) ---
      if (response.ok) {
        // Phase 1: Immediately graduate WARMUP keys to ACTIVE (<500ms)
        await keyStore.acknowledgeHandshake(keyId, leaseToken);
        return { response, keyId, leaseToken };
      }

      // Read structured error payload
      const errJson: OpenRouterErrorPayload = await response
        .clone()
        .json()
        .catch(() => ({}));
      const errText = !errJson?.error
        ? await response.text().catch(() => '')
        : JSON.stringify(errJson);

      // --- CASE 2: UPSTREAM PROVIDER / MODEL OUTAGE DISCRIMINATION ---
      const outageCheck = HealthAndCooldownEngine.isUpstreamProviderOutage(errJson);
      if (outageCheck.isOutage && (response.status === 429 || response.status === 503)) {
        // Do NOT penalize the API key; release with zero cooldown
        await keyStore.releaseKey(
          keyId,
          leaseToken,
          0,
          0,
          `Provider outage: ${outageCheck.provider}`
        );
        throw new UpstreamProviderOutageError(outageCheck.provider || 'UpstreamProvider');
      }

      // --- CASE 3: PERMANENT FINANCIAL EXHAUSTION (402 or 401) ---
      if (response.status === 402 || response.status === 401) {
        lastStatusCode = response.status;
        if (config.accountId) {
          brokenAccountIds.add(config.accountId);
        }
        // Invalidate key and all linked keys in Redis in <5ms
        await keyStore.releaseKey(keyId, leaseToken, response.status, Infinity, errText);
        continue;
      }

      // --- CASE 4: RATE LIMITED (429) ---
      if (response.status === 429) {
        lastStatusCode = 429;
        const states = await keyStore.getAllStates().catch(() => []);
        const currentState = states.find((s) => s.id === keyId);
        const consecutive429s = (currentState?.consecutive429s || 0) + 1;
        const cooldownMs = HealthAndCooldownEngine.calculate429Cooldown(
          response.headers,
          consecutive429s
        );

        await keyStore.releaseKey(keyId, leaseToken, 429, cooldownMs, errText);
        continue;
      }

      // --- CASE 5: TRANSIENT SERVER ERROR (500, 502, 503, 504) ---
      if (response.status >= 500) {
        lastStatusCode = response.status;
        await keyStore.releaseKey(keyId, leaseToken, response.status, 2500, errText);
        continue;
      }

      // --- CASE 6: CLIENT ERROR (400, 404, 413, 422) ---
      // Not a key-specific failure; return directly to caller without rotating
      await keyStore.releaseKey(keyId, leaseToken, response.status, 0, 'Client error');
      return { response, keyId, leaseToken };

    } catch (networkErr: any) {
      cleanupSignal();

      // If client aborted, release lease with status 499 (0 cooldown) and immediately rethrow
      const isClientAbort = clientSignal?.aborted;
      if (isClientAbort) {
        await keyStore.releaseKey(keyId, leaseToken, 499, 0, 'Client stream aborted');
        throw new KeyManagerError(
          'CLIENT_ABORTED: Client disconnected during handshake.',
          499,
          undefined,
          'CLIENT_ABORTED'
        );
      }

      // Outage error was thrown intentionally in Case 2; rethrow
      if (networkErr instanceof UpstreamProviderOutageError) {
        throw networkErr;
      }

      // Network drop or attempt timeout
      const isTimeout = networkErr?.message === 'ATTEMPT_TIMEOUT';
      const status = isTimeout ? 504 : 0;
      lastStatusCode = status;
      const cooldownMs = 2000;
      await keyStore.releaseKey(
        keyId,
        leaseToken,
        status,
        cooldownMs,
        networkErr?.message || 'Handshake network error'
      );
      continue;
    }
  }

  // Terminal error classification after exhausting retry attempts:
  const allStates = await keyStore.getAllStates().catch(() => []);
  const attemptedStates = allStates.filter((s) => attemptedKeyIds.includes(s.id));

  // If all accounts/keys are exhausted (402 credits drained)
  if (
    (allStates.length > 0 && allStates.every((s) => s.status === 'EXHAUSTED')) ||
    (attemptedStates.length > 0 && attemptedStates.every((s) => s.status === 'EXHAUSTED'))
  ) {
    throw new AllAccountsExhaustedError();
  }

  // If all attempted keys are in RATE_LIMITED state (or last error was 429)
  const allAttemptedRateLimited =
    attemptedStates.length > 0 &&
    attemptedStates.every((s) => s.status === 'RATE_LIMITED' || s.status === 'EXHAUSTED');

  if (allAttemptedRateLimited || lastStatusCode === 429) {
    throw new AllKeysRateLimitedError(5);
  }

  throw new FailoverExhaustedError(attemptedKeyIds);
}
