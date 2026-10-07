/**
 * In-Memory Zero-GC Sliding Window Counter Rate Limiter with Bounded LRU Capacity.
 *
 * Implements Cloudflare/RFC-style two-window sliding counter interpolation:
 *   weight = (windowMs - currentElapsed) / windowMs
 *   estimatedCount = prevCount * weight + currentCount
 *
 * Enforces strict 5,000 entry LRU bounded capacity to prevent memory leaks in serverless/Node runtimes.
 * Supports test exemption: bypasses in test mode unless x-test-rate-limit: "true" is provided.
 */

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
}

export interface WindowBucket {
  currentWindowStart: number;
  currentCount: number;
  prevCount: number;
  lastSeen: number;
}

export class SlidingWindowRateLimiter {
  private readonly maxEntries: number;
  private readonly cache = new Map<string, WindowBucket>();

  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Check rate limit for a given key using two-window sliding counter interpolation.
   */
  public check(
    key: string,
    limit: number,
    windowMs: number,
    now: number = Date.now()
  ): RateLimitResult {
    let bucket = this.cache.get(key);

    if (!bucket) {
      if (this.cache.size >= this.maxEntries) {
        // Strict O(1) LRU eviction: evict oldest entry
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
        }
      }
      bucket = {
        currentWindowStart: now,
        currentCount: 0,
        prevCount: 0,
        lastSeen: now,
      };
      this.cache.set(key, bucket);
    } else {
      // Refresh LRU order (delete & set moves key to end of Map)
      this.cache.delete(key);
      this.cache.set(key, bucket);
      bucket.lastSeen = now;
    }

    const elapsed = now - bucket.currentWindowStart;

    if (elapsed < 0) {
      // Clock drift backwards protection
      bucket.currentWindowStart = now;
      bucket.prevCount = 0;
      bucket.currentCount = 0;
    } else if (elapsed >= windowMs * 2) {
      // Both windows completely expired
      bucket.currentWindowStart = now;
      bucket.prevCount = 0;
      bucket.currentCount = 0;
    } else if (elapsed >= windowMs) {
      // Advance to next window: current becomes previous
      bucket.prevCount = bucket.currentCount;
      bucket.currentCount = 0;
      bucket.currentWindowStart += windowMs;
    }

    const currentElapsed = Math.max(0, now - bucket.currentWindowStart);
    const weight = Math.max(0, Math.min(1, (windowMs - currentElapsed) / windowMs));
    const estimatedCount = bucket.prevCount * weight + bucket.currentCount;
    const resetMs = Math.max(1, windowMs - currentElapsed);

    if (estimatedCount + 1 > limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetMs,
      };
    }

    bucket.currentCount += 1;
    const remaining = Math.max(0, Math.floor(limit - (estimatedCount + 1)));

    return {
      allowed: true,
      limit,
      remaining,
      resetMs,
    };
  }

  /**
   * Active pruning of expired buckets older than maxIdleMs (default 2 hours).
   */
  public prune(maxIdleMs = 2 * 60 * 60 * 1000, now: number = Date.now()): number {
    let deleted = 0;
    for (const [key, bucket] of this.cache.entries()) {
      if (now - bucket.lastSeen >= maxIdleMs) {
        this.cache.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  public clear(): void {
    this.cache.clear();
  }

  public get size(): number {
    return this.cache.size;
  }

  public has(key: string): boolean {
    return this.cache.has(key);
  }

  public get(key: string): WindowBucket | undefined {
    return this.cache.get(key);
  }
}

/**
 * Global bounded sliding window rate limiter instance (5,000 maximum capacity).
 */
export const globalLimiter = new SlidingWindowRateLimiter(5000);

export interface RouteLimitPolicy {
  tier: string;
  limit: number;
  windowMs: number;
}

export const ROUTE_POLICIES: Record<string, RouteLimitPolicy> = {
  // Tier 1: Heavy AI Streaming
  ask: { tier: "ask", limit: 10, windowMs: 60_000 },

  // Tier 2: Widget Client Sessions
  widget: { tier: "widget", limit: 30, windowMs: 60_000 },
  widgetCreateThread: { tier: "widget_thread", limit: 20, windowMs: 60_000 },

  // Tier 3: External YouTube API
  youtubeRead: { tier: "youtube_read", limit: 20, windowMs: 60_000 },
  youtubeWrite: { tier: "youtube_write", limit: 10, windowMs: 60_000 },

  // Tier 4: Sensitive Admin Endpoints
  adminRead: { tier: "admin_read", limit: 30, windowMs: 60_000 },
  adminWrite: { tier: "admin_write", limit: 20, windowMs: 60_000 },
  adminUpload: { tier: "admin_upload", limit: 5, windowMs: 60_000 },
  adminCritical: { tier: "admin_critical", limit: 5, windowMs: 60_000 },
  adminComms: { tier: "admin_comms", limit: 10, windowMs: 60_000 },

  // Tier 5: Core Public & Health
  public: { tier: "public", limit: 120, windowMs: 60_000 },
  docs: { tier: "docs", limit: 60, windowMs: 60_000 },

  // Global Fallback
  default: { tier: "default", limit: 60, windowMs: 60_000 },
};

/**
 * Resolves the appropriate rate limiting policy for a given pathname and HTTP method.
 */
export function resolvePolicy(pathname: string, method: string = "GET"): RouteLimitPolicy {
  // Tier 1: Ask (LLM Stream)
  if (pathname === "/v2/ask") return ROUTE_POLICIES.ask;

  // Tier 2: Widget Client
  if (pathname === "/v2/widget/create-thread") return ROUTE_POLICIES.widgetCreateThread;
  if (pathname.startsWith("/v2/widget/")) return ROUTE_POLICIES.widget;

  // Tier 3: YouTube
  if (pathname.startsWith("/v1/youtube/")) {
    if (
      pathname === "/v1/youtube/comment" ||
      pathname === "/v1/youtube/comment/delete" ||
      pathname === "/v1/youtube/reply" ||
      pathname === "/v1/youtube/auth/confirm"
    ) {
      return ROUTE_POLICIES.youtubeWrite;
    }
    return ROUTE_POLICIES.youtubeRead;
  }

  // Tier 4: Admin
  if (pathname.startsWith("/v2/admin/")) {
    if (pathname === "/v2/admin/mail/send" || pathname === "/v2/admin/sms/send") {
      return ROUTE_POLICIES.adminComms;
    }
    if (pathname === "/v2/admin/widgets/upload-icon") return ROUTE_POLICIES.adminUpload;
    if (pathname === "/v2/admin/db/migrate") return ROUTE_POLICIES.adminCritical;
    if (
      pathname.endsWith("/upsert") ||
      pathname.endsWith("/delete") ||
      pathname.endsWith("/update") ||
      pathname.endsWith("/rename")
    ) {
      return ROUTE_POLICIES.adminWrite;
    }
    return ROUTE_POLICIES.adminRead;
  }

  // Tier 5: Public / Docs / Health
  if (pathname === "/json" || pathname === "/v1/heartbeat") return ROUTE_POLICIES.docs;
  if (pathname === "/" || pathname === "/v1/healthz" || pathname === "/api/hello") return ROUTE_POLICIES.public;

  return ROUTE_POLICIES.default;
}

/**
 * Extracts normalized client IP from request headers or fallback to 127.0.0.1.
 */
export function extractClientIp(
  req: Request | { headers?: Headers | Record<string, string | undefined> | null } | null | undefined
): string {
  if (!req) return "127.0.0.1";

  let headers: Headers | Record<string, string | undefined> | undefined;
  if (req instanceof Request) {
    headers = req.headers;
  } else if ("headers" in req && req.headers) {
    headers = req.headers;
  }

  const getHeader = (name: string): string | null => {
    if (!headers) return null;
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(name);
    }
    const record = headers as Record<string, string | undefined>;
    return record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()] ?? null;
  };

  const xForwardedFor = getHeader("x-forwarded-for");
  if (xForwardedFor) {
    const firstIp = xForwardedFor.split(",")[0].trim();
    if (firstIp) return firstIp;
  }

  const xRealIp = getHeader("x-real-ip");
  if (xRealIp?.trim()) return xRealIp.trim();

  const cfConnectingIp = getHeader("cf-connecting-ip");
  if (cfConnectingIp?.trim()) return cfConnectingIp.trim();

  return "127.0.0.1";
}

let testEnforcementOverride: boolean | null = null;

export function setTestRateLimitEnforced(enforced: boolean | null): void {
  testEnforcementOverride = enforced;
}

/**
 * Evaluates whether rate limiting should be bypassed in test environment.
 * When NODE_ENV === "test", returns true unless x-test-rate-limit: "true" header is present.
 */
export function isTestRateLimitBypassed(
  req?: Request | Headers | { headers?: any } | Record<string, any> | null
): boolean {
  if (process.env.NODE_ENV === "test") {
    if (testEnforcementOverride !== null) {
      return !testEnforcementOverride;
    }
    if (!req) return false;

    let headerVal: string | null = null;
    if (req instanceof Request) {
      headerVal = req.headers.get("x-test-rate-limit");
    } else if (typeof (req as Headers).get === "function") {
      headerVal = (req as Headers).get("x-test-rate-limit");
    } else if (typeof (req as any).headers?.get === "function") {
      headerVal = (req as any).headers.get("x-test-rate-limit");
    } else if ((req as any).headers) {
      headerVal =
        (req as any).headers["x-test-rate-limit"] ??
        (req as any).headers["X-Test-Rate-Limit"] ??
        null;
    } else {
      headerVal =
        (req as any)["x-test-rate-limit"] ??
        (req as any)["X-Test-Rate-Limit"] ??
        null;
    }
    return headerVal !== "true";
  }
  return false;
}

export const shouldBypassRateLimit = isTestRateLimitBypassed;

/**
 * Primary rate limit check interface contract (PROJECT.md lines 41-46):
 * checkRateLimit(key: string, limit: number, windowMs: number): { allowed: boolean; remaining: number; resetMs: number }
 *
 * Optional request parameter enables automatic test mode bypass checking.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  reqOrHeaders?: Request | Headers | { headers?: any } | Record<string, any> | null,
  now?: number
): RateLimitResult {
  if (reqOrHeaders && isTestRateLimitBypassed(reqOrHeaders)) {
    return {
      allowed: true,
      limit,
      remaining: limit,
      resetMs: 0,
    };
  }

  return globalLimiter.check(key, limit, windowMs, now);
}

/**
 * Reset rate limiter state for hermetic unit testing.
 */
export function resetRateLimitsForTesting(): void {
  globalLimiter.clear();
  testEnforcementOverride = null;
}
