import { createClient } from "@supabase/supabase-js";
import { Database } from "./database.types";

export const createSupabaseClient = <T extends keyof Database>(schema: T) => {
  const supabase = createClient<Database, T>(
    process.env.SUPABASE_URL ??
      (() => {
        throw new Error("SUPABASE_URL is not set");
      })(),
    process.env.SUPABASE_SERVICE_KEY ??
      (() => {
        throw new Error("SUPABASE_SERVICE_KEY is not set");
      })(),
    {
      db: { schema },
    },
  );

  return supabase;
};

// Lazy proxy — Supabase client을 module-load 시점이 아니라 첫 접근 시점에 생성.
// 환경변수 누락이 있어도 module load는 성공하므로 cold start 크래시 (FUNCTION_INVOCATION_FAILED) 방지.
// 실제 사용처에서 호출되는 시점에 throw → handler try/catch가 JSON 에러로 변환 가능.
let _cachedClient: ReturnType<typeof createSupabaseClient<"public">> | null = null;
const getClient = () => {
  if (!_cachedClient) _cachedClient = createSupabaseClient<"public">("public");
  return _cachedClient;
};

export const supabaseClient = new Proxy({} as ReturnType<typeof createSupabaseClient<"public">>, {
  get(_target, prop) {
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
