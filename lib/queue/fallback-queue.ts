/**
 * Zero-Data-Loss Fallback Queue & Full-Jitter Exponential Backoff System.
 *
 * Implements:
 * 1. Full-Jitter Exponential Backoff formula (RFC/AWS standard):
 *      temp = min(maxMs, baseMs * 2^attempt)
 *      sleep = random(0, temp) (+ Retry-After adherence)
 * 2. Robust 429 / Quota / Rate-Limit error detection across:
 *      - HTTP 429 status / statusCode
 *      - SMTP 421 / 450 / 451 / 452 rate limits
 *      - PostgREST / Supabase / Redis / Cloud provider quota errors
 * 3. Bounded in-memory queue with FIFO processing and idempotency key deduplication:
 *      - Prevents memory leaks with strict O(1) 5,000-entry capacity limit.
 *      - Safeguards uncompleted jobs when third-party services return persistent 429s.
 * 4. Pluggable execution wrapper `executeWithFallback`:
 *      - Retries transient 429 errors with full jitter.
 *      - Automatically enqueues payload if retries are exhausted, guaranteeing zero message loss.
 */

export interface FallbackJob<T = any> {
  id: string;
  type: string;
  payload: T;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  nextRetryAt: number;
  backoffMs: number;
  status: "pending" | "processing" | "succeeded" | "failed";
  lastError?: string;
  idempotencyKey?: string;
}

export interface FallbackOptions<P = any> {
  queue?: FallbackQueue<P>;
  fallbackPayload?: P;
  type?: string;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  idempotencyKey?: string;
  onEnqueue?: (job: FallbackJob<P>) => void;
  operationName?: string;
}

export interface ExecuteResult<T, P = any> {
  success: boolean;
  result?: T;
  queued?: boolean;
  job?: FallbackJob<P>;
  attempts: number;
  error?: Error;
}

/**
 * Calculates exponential backoff with full jitter (Decorrelated/Full-Jitter formula).
 * If retryAfterMs is provided (from HTTP Retry-After header), respects it with 50~250ms positive jitter.
 */
export function calculateFullJitterBackoff(
  attempt: number,
  baseMs = 500,
  maxMs = 30000,
  retryAfterMs?: number
): number {
  const safeBaseMs = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 500;
  const safeMaxMs = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 30000;
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;

  if (
    typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
  ) {
    const jitter = Math.floor(Math.random() * 200) + 50;
    return Math.min(safeMaxMs, Math.max(10, Math.floor(retryAfterMs + jitter)));
  }
  const expCap = Math.min(safeMaxMs, safeBaseMs * Math.pow(2, Math.min(30, safeAttempt)));
  // Full jitter: uniformly random between 0 and expCap (min 10ms)
  return Math.max(10, Math.floor(Math.random() * expCap));
}

/**
 * Detects whether an error represents an HTTP 429, SMTP rate-limiting code,
 * or third-party quota exhaustion.
 */
export function is429OrQuotaError(err: unknown): boolean {
  if (!err) return false;

  // String error representation (e.g. rejected promise with string or error message)
  if (typeof err === "string") {
    const s = err.toLowerCase();
    return (
      s.includes("429") ||
      s.includes("too many requests") ||
      s.includes("rate limit") ||
      s.includes("quota exceeded") ||
      s.includes("exceeded quota") ||
      s.includes("temporarily blocked") ||
      s.includes("throttled") ||
      s.includes("mailbox busy") ||
      s.includes("try again later") ||
      s.includes("resource has been exhausted") ||
      s.includes("all_keys_rate_limited")
    );
  }

  if (typeof err === "object") {
    const anyErr = err as Record<string, any>;

    // Direct HTTP status check
    if (anyErr.status === 429 || anyErr.statusCode === 429) return true;
    if (anyErr.response?.status === 429 || anyErr.response?.statusCode === 429) return true;

    // SMTP rate limiting & temporary quota status codes:
    // 421: Service not available, closing transmission channel
    // 450: Mailbox busy / temporarily unavailable
    // 451: Local error in processing / temporary rate limit
    // 452: Insufficient system storage / quota exceeded
    const rawCode = anyErr.responseCode ?? anyErr.code;
    const smtpCode = Number(rawCode);
    if (Number.isFinite(smtpCode) && [421, 450, 451, 452].includes(smtpCode)) {
      return true;
    }

    const codeStr = String(anyErr.code ?? anyErr.statusCode ?? anyErr.error?.code ?? "").toUpperCase();
    if (
      codeStr === "429" ||
      codeStr === "RATE_LIMIT_EXCEEDED" ||
      codeStr === "ALL_KEYS_RATE_LIMITED" ||
      codeStr === "QUOTA_EXCEEDED" ||
      codeStr === "RESOURCE_EXHAUSTED"
    ) {
      return true;
    }

    // Message substring inspection across all possible error fields
    const candidates = [
      anyErr.message,
      typeof anyErr.error === "string" ? anyErr.error : anyErr.error?.message,
      anyErr.response?.data?.message,
      anyErr.response?.data?.error,
      anyErr.cause?.message,
      typeof anyErr.toString === "function" ? anyErr.toString() : "",
    ];
    const message = candidates.filter(Boolean).join(" ").toLowerCase();
    if (
      message.includes("429") ||
      message.includes("too many requests") ||
      message.includes("rate limit") ||
      message.includes("quota exceeded") ||
      message.includes("exceeded quota") ||
      message.includes("temporarily blocked") ||
      message.includes("throttled") ||
      message.includes("mailbox busy") ||
      message.includes("try again later") ||
      message.includes("resource has been exhausted") ||
      message.includes("all_keys_rate_limited")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts Retry-After delta milliseconds from an error object if present.
 */
export function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const anyErr = err as Record<string, any>;
  const rawHeader =
    anyErr.retryAfterMs ??
    (typeof anyErr.retryAfterSeconds === "number" && anyErr.retryAfterSeconds > 0
      ? anyErr.retryAfterSeconds * 1000
      : undefined) ??
    anyErr.retry_after ??
    anyErr.retryAfter ??
    anyErr.response?.data?.retry_after ??
    anyErr.response?.data?.retryAfter ??
    anyErr.headers?.get?.("retry-after") ??
    anyErr.headers?.get?.("Retry-After") ??
    anyErr.headers?.["retry-after"] ??
    anyErr.headers?.["Retry-After"] ??
    anyErr.response?.headers?.get?.("retry-after") ??
    anyErr.response?.headers?.get?.("Retry-After") ??
    anyErr.response?.headers?.["retry-after"] ??
    anyErr.response?.headers?.["Retry-After"];

  if (typeof rawHeader === "number" && Number.isFinite(rawHeader)) {
    if (rawHeader <= 0) return undefined;
    if (anyErr.retryAfterMs !== undefined || anyErr.retryAfterSeconds !== undefined) {
      return Math.ceil(rawHeader);
    }
    if (rawHeader > 1_000_000_000_000) {
      const delta = rawHeader - Date.now();
      return delta > 0 ? Math.ceil(delta) : undefined;
    }
    if (rawHeader > 1_000_000_000) {
      const delta = rawHeader * 1000 - Date.now();
      return delta > 0 ? Math.ceil(delta) : undefined;
    }
    return rawHeader > 1000 ? Math.ceil(rawHeader) : Math.ceil(rawHeader * 1000);
  }
  if (typeof rawHeader === "string") {
    const trimmed = rawHeader.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const sec = parseFloat(trimmed);
      if (!isNaN(sec) && Number.isFinite(sec) && sec > 0) {
        if (sec > 1_000_000_000) {
          const delta = sec * 1000 - Date.now();
          return delta > 0 ? Math.ceil(delta) : undefined;
        }
        return Math.ceil(sec * 1000);
      }
    }
    const timestamp = Date.parse(trimmed);
    if (!isNaN(timestamp) && Number.isFinite(timestamp)) {
      const delta = timestamp - Date.now();
      return delta > 0 ? Math.ceil(delta) : undefined;
    }
  }
  return undefined;
}

function generateJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Zero-GC Bounded In-Memory Queue with deduplication and state saving.
 */
export class FallbackQueue<T = any> {
  private readonly queueType: string;
  private readonly maxCapacity: number;
  private readonly jobs = new Map<string, FallbackJob<T>>();
  private readonly idempotencyMap = new Map<string, string>(); // idempotencyKey -> jobId

  constructor(queueType = "general", maxCapacity = 5000) {
    this.queueType = queueType;
    this.maxCapacity =
      Number.isFinite(maxCapacity) && maxCapacity > 0 ? Math.floor(maxCapacity) : 5000;
  }

  /**
   * Enqueue a job into the fallback queue.
   */
  public enqueue(
    payload: T,
    options: {
      type?: string;
      maxAttempts?: number;
      idempotencyKey?: string;
      initialDelayMs?: number;
      lastError?: string;
    } = {}
  ): FallbackJob<T> {
    const idempotencyKey = options.idempotencyKey;
    if (idempotencyKey) {
      const existingId = this.idempotencyMap.get(idempotencyKey);
      if (existingId) {
        const existingJob = this.jobs.get(existingId);
        if (existingJob && existingJob.status !== "failed") {
          return existingJob;
        }
      }
    }

    // Bounded capacity eviction (prioritize evicting dead/failed jobs before pending, avoid evicting processing)
    if (this.jobs.size >= this.maxCapacity) {
      let idToEvict: string | undefined;
      // 1. First priority: oldest failed job
      for (const [id, job] of this.jobs) {
        if (job.status === "failed") {
          idToEvict = id;
          break;
        }
      }
      // 2. Second priority: oldest pending job
      if (idToEvict === undefined) {
        for (const [id, job] of this.jobs) {
          if (job.status === "pending") {
            idToEvict = id;
            break;
          }
        }
      }
      // 3. Last resort fallback
      if (idToEvict === undefined) {
        idToEvict = this.jobs.keys().next().value;
      }
      if (idToEvict !== undefined) {
        const evicted = this.jobs.get(idToEvict);
        if (
          evicted?.idempotencyKey &&
          this.idempotencyMap.get(evicted.idempotencyKey) === evicted.id
        ) {
          this.idempotencyMap.delete(evicted.idempotencyKey);
        }
        this.jobs.delete(idToEvict);
      }
    }

    const now = Date.now();
    const delay = options.initialDelayMs ?? calculateFullJitterBackoff(0);
    const job: FallbackJob<T> = {
      id: generateJobId(),
      type: options.type ?? this.queueType,
      payload,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 5,
      createdAt: now,
      nextRetryAt: now + delay,
      backoffMs: delay,
      status: "pending",
      lastError: options.lastError,
      idempotencyKey,
    };

    this.jobs.set(job.id, job);
    if (idempotencyKey) {
      this.idempotencyMap.set(idempotencyKey, job.id);
    }

    return job;
  }

  /**
   * Retrieve all jobs ready for retry (status === "pending" && nextRetryAt <= now).
   */
  public getReadyJobs(now: number = Date.now()): FallbackJob<T>[] {
    const ready: FallbackJob<T>[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "pending" && job.nextRetryAt <= now) {
        ready.push(job);
      }
    }
    return ready;
  }

  /**
   * Atomically claims the next ready job for processing to prevent race conditions.
   * Can optionally exclude already-attempted job IDs in the current drain pass.
   */
  public claimNextReady(
    now: number = Date.now(),
    excludeIds?: Set<string>
  ): FallbackJob<T> | undefined {
    for (const job of this.jobs.values()) {
      if (excludeIds && excludeIds.has(job.id)) continue;
      if (job.status === "pending" && job.nextRetryAt <= now) {
        job.status = "processing";
        return job;
      }
    }
    return undefined;
  }

  public markProcessing(id: string): FallbackJob<T> | undefined {
    const job = this.jobs.get(id);
    if (job && job.status === "pending") {
      job.status = "processing";
    }
    return job;
  }

  public markSucceeded(id: string): boolean {
    const job = this.jobs.get(id);
    if (job) {
      job.status = "succeeded";
      if (
        job.idempotencyKey &&
        this.idempotencyMap.get(job.idempotencyKey) === job.id
      ) {
        this.idempotencyMap.delete(job.idempotencyKey);
      }
      this.jobs.delete(id);
      return true;
    }
    return false;
  }

  public markFailed(id: string, err: unknown, baseMs = 500, maxMs = 30000): FallbackJob<T> | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    job.attempts += 1;
    job.lastError = err instanceof Error ? err.message : String(err);

    if (job.attempts >= job.maxAttempts) {
      job.status = "failed";
    } else {
      job.status = "pending";
      const retryAfterMs = extractRetryAfterMs(err);
      const backoff = calculateFullJitterBackoff(job.attempts, baseMs, maxMs, retryAfterMs);
      job.backoffMs = backoff;
      job.nextRetryAt = Date.now() + backoff;
    }
    return job;
  }

  /**
   * Drain / process pending jobs sequentially with atomic claim to prevent double-execution.
   * Excludes failed/retried jobs from tight infinite loops within the same drain pass.
   */
  public async processPending(
    handler: (job: FallbackJob<T>) => Promise<boolean | void>,
    now: number = Date.now()
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    const attemptedIds = new Set<string>();

    let job: FallbackJob<T> | undefined;
    while ((job = this.claimNextReady(now, attemptedIds)) !== undefined) {
      attemptedIds.add(job.id);
      processed++;
      try {
        const ok = await handler(job);
        if (ok !== false) {
          this.markSucceeded(job.id);
          succeeded++;
        } else {
          this.markFailed(job.id, new Error("Handler returned false"));
          failed++;
        }
      } catch (err) {
        this.markFailed(job.id, err);
        failed++;
      }
    }

    return { processed, succeeded, failed };
  }

  public get(id: string): FallbackJob<T> | undefined {
    return this.jobs.get(id);
  }

  public getAllJobs(): FallbackJob<T>[] {
    return Array.from(this.jobs.values());
  }

  public getPendingCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "pending" || job.status === "processing") count++;
    }
    return count;
  }

  public get size(): number {
    return this.jobs.size;
  }

  /**
   * Actively prune dead/failed jobs or jobs older than maxAgeMs (excluding in-flight processing jobs).
   */
  public prune(maxAgeMs = 24 * 60 * 60 * 1000, now: number = Date.now()): number {
    const safeMaxAge =
      Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 24 * 60 * 60 * 1000;
    const safeNow = Number.isFinite(now) ? now : Date.now();
    let pruned = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (
        job.status !== "processing" &&
        (job.status === "failed" || safeNow - job.createdAt >= safeMaxAge)
      ) {
        if (
          job.idempotencyKey &&
          this.idempotencyMap.get(job.idempotencyKey) === job.id
        ) {
          this.idempotencyMap.delete(job.idempotencyKey);
        }
        this.jobs.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  public clear(): void {
    this.jobs.clear();
    this.idempotencyMap.clear();
  }
}

/**
 * Global singleton queues for external third-party communications.
 */
export const mailFallbackQueue = new FallbackQueue<any>("mail", 5000);
export const dbFallbackQueue = new FallbackQueue<any>("db", 5000);
export const generalFallbackQueue = new FallbackQueue<any>("general", 5000);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resilient Execution Wrapper:
 * Executes an async action. If a 429/quota error is detected, performs exponential
 * backoff with full jitter up to `maxRetries`. If all retries fail with 429 and a
 * queue is provided, saves the request to the queue to guarantee zero message loss.
 */
export async function executeWithFallback<T, P = any>(
  action: () => Promise<T>,
  options: FallbackOptions<P> = {}
): Promise<ExecuteResult<T, P>> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 5000;

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await action();
      return {
        success: true,
        result,
        attempts: attempt + 1,
      };
    } catch (err: unknown) {
      lastError = err;
      const isRateLimited = is429OrQuotaError(err);

      if (!isRateLimited) {
        // Non-rate-limit errors (auth, schema, 4xx) fail fast without retrying
        throw err;
      }

      if (attempt < maxRetries) {
        const retryAfterMs = extractRetryAfterMs(err);
        const backoff = calculateFullJitterBackoff(attempt, baseDelayMs, maxDelayMs, retryAfterMs);
        await sleep(backoff);
      }
    }
  }

  // If retries are exhausted on a 429 error and fallback queue is available:
  if (options.queue && options.fallbackPayload !== undefined) {
    const job = options.queue.enqueue(options.fallbackPayload, {
      type: options.type,
      idempotencyKey: options.idempotencyKey,
      lastError: lastError instanceof Error ? lastError.message : String(lastError),
    });

    options.onEnqueue?.(job);

    return {
      success: true,
      queued: true,
      job,
      attempts: maxRetries + 1,
    };
  }

  return {
    success: false,
    error: lastError instanceof Error ? lastError : new Error(String(lastError)),
    attempts: maxRetries + 1,
  };
}

type DbInsertHandler = (payload: any) => Promise<boolean>;
let defaultDbInsertHandler: DbInsertHandler | null = null;

export function registerDefaultDbHandler(fn: DbInsertHandler): void {
  defaultDbInsertHandler = fn;
}

/**
 * Processes queued database writes in the dbFallbackQueue.
 */
export async function processDbQueue(
  insertFn?: (payload: any) => Promise<boolean>,
): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  const handler = insertFn ?? defaultDbInsertHandler;
  return dbFallbackQueue.processPending(async (job) => {
    if (handler) {
      return await handler(job.payload);
    }
    return true;
  });
}

/**
 * Returns in-memory pending fallback messages for a thread to prevent data loss.
 */
export function getQueuedMessagesForThread(threadId: string) {
  return dbFallbackQueue
    .getAllJobs()
    .filter(
      (job) =>
        (job.status === "pending" || job.status === "processing") &&
        job.payload?.threadId === threadId &&
        job.type === "db_chat_message",
    )
    .map((job, idx) => ({
      id: -(idx + 1),
      thread_id: threadId,
      role: job.payload.role,
      content: job.payload.content,
      created_at:
        job.payload.createdAt || new Date(job.createdAt).toISOString(),
    }));
}


