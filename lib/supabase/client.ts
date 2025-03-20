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

export const supabaseClient = createSupabaseClient<"public">("public");

export type Supabase = ReturnType<typeof createSupabaseClient<"public">>;
