import { createClient } from "@supabase/supabase-js";
import { Database } from "./database.types";

const DEFAULT_SUPABASE_TIMEOUT_MS = 8_000;

function resolveSupabaseTimeoutMs(): number {
  const raw = process.env.SUPABASE_FETCH_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_SUPABASE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 50 && parsed <= 55_000
    ? parsed
    : DEFAULT_SUPABASE_TIMEOUT_MS;
}

const boundedSupabaseFetch: typeof fetch = (input, init) => {
  const timeoutMs = resolveSupabaseTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const abortErr = Object.assign(
      new Error(`Supabase request timed out after ${timeoutMs}ms`),
      { name: "AbortError" },
    );
    controller.abort(abortErr);
  }, timeoutMs);

  const callerSignal = init?.signal;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  return globalThis.fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    if (callerSignal) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  });
};

export const createSupabaseClient = <T extends keyof Database>(schema: T) => {
  const url = process.env.SUPABASE_URL?.trim();
  if (!url) {
    throw new Error("SUPABASE_URL is not set");
  }
  const key = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!key) {
    throw new Error("SUPABASE_SERVICE_KEY is not set");
  }
  const supabase = createClient<Database, any>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: { schema: schema as any },
    global: { fetch: boundedSupabaseFetch },
  });

  return supabase;
};

// Lazy proxy — Supabase client을 module-load 시점이 아니라 첫 접근 시점에 생성.
// 환경변수 누락이 있어도 module load는 성공하므로 cold start 크래시 (FUNCTION_INVOCATION_FAILED) 방지.
// 실제 사용처에서 호출되는 시점에 throw → handler try/catch가 JSON 에러로 변환 가능.
let _cachedClient: ReturnType<typeof createSupabaseClient<"public">> | null = null;
let _cachedSig: string | null = null;

const getClient = () => {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_KEY?.trim();
  const sig = url && key ? `${url}\0${key}` : null;
  if (!_cachedClient || !sig || _cachedSig !== sig) {
    _cachedClient = null;
    _cachedSig = null;
    _cachedClient = createSupabaseClient<"public">("public");
    _cachedSig = sig;
  }
  return _cachedClient;
};

export const supabaseClient = new Proxy({} as ReturnType<typeof createSupabaseClient<"public">>, {
  get(_target, prop) {
    if (prop === "then") return undefined;
    return Reflect.get(getClient() as any, prop);
  },
});

export type Supabase = ReturnType<typeof createSupabaseClient<"public">>;

/**
 * Escape hatch for tables that aren't in `database.types.ts` yet
 * (chat_thread, chat_message, widget — Supabase introspection needs re-running).
 *
 * The generated `Database` type turns every chained call on an unknown table
 * into a type error, and a `@ts-expect-error` only suppresses the ONE line
 * that follows it — so it can never cover a
 * `.from().select().eq().order().limit()` chain. That left ~1100 errors in
 * `next build`. Route those queries through this handle instead; it is the
 * same client object at runtime, only the compile-time types are loosened.
 *
 * Delete this once the tables are in the generated types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabaseUntyped = supabaseClient as unknown as { from: (table: string) => any };
