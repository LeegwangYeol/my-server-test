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
  resetEpochSec: number;
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
    this.maxEntries =
      Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 5000;
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
    const safeKey = (key || "unknown").trim();
    const safeLimit = Number.isFinite(limit) && limit >= 0 ? limit : 0;
    const safeWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000;
    const safeNow = Number.isFinite(now) ? now : Date.now();

    let bucket = this.cache.get(safeKey);

    if (!bucket) {
      if (this.cache.size >= this.maxEntries) {
        // Strict O(1) LRU eviction: evict oldest entry
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
        }
      }
      bucket = {
        currentWindowStart: safeNow,
        currentCount: 0,
        prevCount: 0,
        lastSeen: safeNow,
      };
      this.cache.set(safeKey, bucket);
    } else {
      // Refresh LRU order (delete & set moves key to end of Map)
      this.cache.delete(safeKey);
      this.cache.set(safeKey, bucket);
      bucket.lastSeen = safeNow;
    }

    const elapsed = safeNow - bucket.currentWindowStart;

    if (elapsed < 0) {
      // Clock drift backwards protection: adjust window start without wiping counts
      bucket.currentWindowStart = safeNow;
    } else if (elapsed >= safeWindowMs * 2) {
      // Both windows completely expired
      bucket.currentWindowStart = safeNow;
      bucket.prevCount = 0;
      bucket.currentCount = 0;
    } else if (elapsed >= safeWindowMs) {
      // Advance to next window: current becomes previous
      bucket.prevCount = bucket.currentCount;
      bucket.currentCount = 0;
      bucket.currentWindowStart += safeWindowMs;
    }

    const currentElapsed = Math.max(0, safeNow - bucket.currentWindowStart);
    const weight = Math.max(0, Math.min(1, (safeWindowMs - currentElapsed) / safeWindowMs));
    const estimatedCount = bucket.prevCount * weight + bucket.currentCount;
    const resetMs = Math.max(1, safeWindowMs - currentElapsed);
    const resetEpochSec = Math.ceil((safeNow + resetMs) / 1000);

    if (estimatedCount + 1 > safeLimit) {
      return {
        allowed: false,
        limit: safeLimit,
        remaining: 0,
        resetMs,
        resetEpochSec,
      };
    }

    bucket.currentCount += 1;
    const remaining = Math.max(0, Math.floor(safeLimit - (estimatedCount + 1)));

    return {
      allowed: true,
      limit: safeLimit,
      remaining,
      resetMs,
      resetEpochSec,
    };
  }

  /**
   * Active pruning of expired buckets older than maxIdleMs (default 2 hours).
   */
  public prune(maxIdleMs = 2 * 60 * 60 * 1000, now: number = Date.now()): number {
    const safeIdle =
      Number.isFinite(maxIdleMs) && maxIdleMs > 0 ? maxIdleMs : 2 * 60 * 60 * 1000;
    const safeNow = Number.isFinite(now) ? now : Date.now();
    let deleted = 0;
    for (const [key, bucket] of this.cache.entries()) {
      if (safeNow - bucket.lastSeen >= safeIdle) {
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
  let p = (pathname || "/").trim();
  // Collapse consecutive slashes e.g. /v2//ask -> /v2/ask
  p = p.replace(/\/+/g, "/");
  // Strip /api prefix if present (case-insensitive Vercel rewrite parity)
  if (p.toLowerCase().startsWith("/api/")) {
    p = p.slice(4);
  }
  // Strip all trailing slashes for non-root paths (e.g. /v2/ask/// -> /v2/ask)
  if (p.length > 1) {
    p = p.replace(/\/+$/, "");
  }

  // Tier 1: Ask (LLM Stream)
  if (p === "/v2/ask") return ROUTE_POLICIES.ask;

  // Tier 2: Widget Client
  if (p === "/v2/widget/create-thread") return ROUTE_POLICIES.widgetCreateThread;
  if (p.startsWith("/v2/widget/")) return ROUTE_POLICIES.widget;

  // Tier 3: YouTube
  if (p.startsWith("/v1/youtube/")) {
    if (
      p === "/v1/youtube/comment" ||
      p === "/v1/youtube/comment/delete" ||
      p === "/v1/youtube/reply" ||
      p === "/v1/youtube/auth/confirm"
    ) {
      return ROUTE_POLICIES.youtubeWrite;
    }
    return ROUTE_POLICIES.youtubeRead;
  }

  // Tier 4: Admin
  if (p.startsWith("/v2/admin/")) {
    if (p === "/v2/admin/mail/send" || p === "/v2/admin/sms/send") {
      return ROUTE_POLICIES.adminComms;
    }
    if (p === "/v2/admin/widgets/upload-icon") return ROUTE_POLICIES.adminUpload;
    if (p === "/v2/admin/db/migrate") return ROUTE_POLICIES.adminCritical;
    if (
      p.endsWith("/upsert") ||
      p.endsWith("/delete") ||
      p.endsWith("/update") ||
      p.endsWith("/rename")
    ) {
      return ROUTE_POLICIES.adminWrite;
    }
    return ROUTE_POLICIES.adminRead;
  }

  // Tier 5: Public / Docs / Health
  if (p === "/json" || p === "/v1/heartbeat") return ROUTE_POLICIES.docs;
  if (p === "" || p === "/" || p === "/v1/healthz" || p === "/hello" || p === "/api/hello") return ROUTE_POLICIES.public;

  return ROUTE_POLICIES.default;
}

/**
 * Sanitizes and normalizes an IP string (strips quotes, ports, brackets, and whitespace).
 */
export function normalizeIp(raw: string): string {
  let ip = (raw || "").trim();
  if (!ip) return "127.0.0.1";

  // Strip surrounding quotes if present (e.g. "1.2.3.4" or '1.2.3.4')
  ip = ip.replace(/^["']+|["']+$/g, "").trim();
  if (!ip) return "127.0.0.1";

  // Bracketed IPv6/IPv4-mapped with optional port: [2001:db8::1]:8080 or [::ffff:192.168.1.1]:8080 or [fe80::1%eth0]:8080
  const bracketMatch = ip.match(/^\[([a-zA-Z0-9:.%_\-]+)\](?::\d+)?$/);
  if (bracketMatch) {
    return bracketMatch[1].toLowerCase();
  }

  // IPv4 with port: 1.2.3.4:8080
  const ipv4PortMatch = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/);
  if (ipv4PortMatch) {
    return ipv4PortMatch[1];
  }

  // Pure IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return ip;
  }

  // Pure IPv6 or IPv4-mapped IPv6 (contains colons)
  if (ip.includes(":")) {
    // If IPv4-mapped with trailing port without brackets, e.g. ::ffff:192.168.1.1:8080
    const mappedPortMatch = ip.match(/^((?:[a-fA-F0-9:]+:)?\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/);
    if (mappedPortMatch) {
      return mappedPortMatch[1].toLowerCase();
    }
    return ip.toLowerCase();
  }

  return ip;
}

/**
 * Extracts normalized client IP from request headers or fallback to 127.0.0.1.
 */
export function extractClientIp(
  req: Request | Headers | { headers?: Headers | Record<string, string | undefined> | null } | null | undefined
): string {
  if (!req) return "127.0.0.1";

  let headers: Headers | Record<string, string | undefined> | undefined;
  if (req instanceof Request) {
    headers = req.headers;
  } else if (req instanceof Headers || (typeof (req as any)?.get === "function" && !("headers" in req))) {
    headers = req as any;
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

  // Priority 1: Cloudflare Edge IP (authoritative, cannot be spoofed by client)
  const cfConnectingIp = getHeader("cf-connecting-ip");
  if (cfConnectingIp?.trim()) return normalizeIp(cfConnectingIp);

  // Priority 2: Reverse proxy header (e.g. Nginx, ALB)
  const xRealIp = getHeader("x-real-ip");
  if (xRealIp?.trim()) return normalizeIp(xRealIp);

  // Priority 3: X-Forwarded-For (extract first non-empty IP entry)
  const xForwardedFor = getHeader("x-forwarded-for");
  if (xForwardedFor) {
    const ips = xForwardedFor.split(",").map((s) => s.trim()).filter(Boolean);
    if (ips.length > 0) {
      return normalizeIp(ips[0]);
    }
  }

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
  const t = now ?? Date.now();
  if (reqOrHeaders && isTestRateLimitBypassed(reqOrHeaders)) {
    return {
      allowed: true,
      limit,
      remaining: limit,
      resetMs: 0,
      resetEpochSec: Math.ceil((t + windowMs) / 1000),
    };
  }

  return globalLimiter.check(key, limit, windowMs, t);
}

/**
 * Reset rate limiter state for hermetic unit testing.
 */
export function resetRateLimitsForTesting(): void {
  globalLimiter.clear();
  testEnforcementOverride = null;
}
