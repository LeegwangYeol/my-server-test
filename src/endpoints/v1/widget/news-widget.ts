import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";

export const v1NewsWidget = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/news-widget",
    async ({ body }) => {
      const { widgetId } = body;

      const { data } = await supabaseClient
        .from("llami_news")
        .select("*")
        .eq("widget_id", widgetId)
        .order("created_at", { ascending: false });

      return {
        success: true,
        data,
      };
    },
    {
      detail: {
        tags: ["Widget News"],
        description: "News Widget",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        widgetId: t.String({
          description: "Widget ID",
          error: "Widget ID is required",
          minLength: 1,
          maxLength: 100,
        }),
      }),
    },
  );
};
