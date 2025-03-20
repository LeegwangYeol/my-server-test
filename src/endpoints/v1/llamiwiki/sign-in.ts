import { Elysia, t } from "elysia";
import { supabaseClient } from "../../../../lib/supabase/client";

export const v1LlamiwikiSignIn = async (app: Elysia<"/v1/llamiwiki">) => {
  app.post(
    "/sign-in",
    async ({ body: { email, password } }) => {
      await supabaseClient.from("user").upsert({
        email: email,
        password: password,
      });

      return {
        success: true,
      };
    },
    {
      detail: {
        tags: ["LLamiwiki"],
        description: "LLamiwiki login endpoint",
      },
      body: t.Object({
        email: t.String({
          description: "User email",
          error: "Email is required",
          minLength: 20,
          maxLength: 30,
        }),
        password: t.String({
          description: "User password",
          error: "Password is required",
          minLength: 8,
          maxLength: 15,
        }),
      }),
    },
  );
};
