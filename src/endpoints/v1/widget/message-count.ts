import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetMessageCount = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/message-count",
    async ({ body, cookie }) => {
      const { widgetId } = body;

      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 위젯 정보 확인
      const { data: widget, error: widgetError } = await supabaseClient
        .from("llami_widget")
        .select("*")
        .eq("id", widgetId)
        .eq("is_deleted", false)
        .limit(1)
        .maybeSingle();

      if (widgetError || !widget) {
        return {
          success: false,
          message: "존재하지 않는 위젯입니다.",
        };
      }

      // * 위젯에 속한 스레드 목록 조회
      const { data: threads, error: threadsError } = await supabaseClient
        .from("llami_widget_thread")
        .select(
          `
          id
        `,
        )
        .eq("widget_id", widgetId)
        .eq("is_deleted", false);

      if (threadsError) {
        return {
          success: false,
          message: "스레드 정보를 가져오는 중 오류가 발생했습니다.",
        };
      }

      if (!threads || threads.length === 0) {
        return {
          success: true,
          data: 0,
        };
      }

      // * 각 스레드의 메시지 수 조회
      const threadIds = threads.map((thread) => thread.id);
      const { count: totalMessageCount, error: messageCountError } =
        await supabaseClient
          .from("llami_widget_thread_message")
          .select("*", { count: "exact", head: true })
          .in("thread_id", threadIds);

      if (messageCountError) {
        return {
          success: false,
          message: "메시지 수를 계산하는 중 오류가 발생했습니다.",
        };
      }

      return {
        success: true,
        data: totalMessageCount || 0,
      };
    },
    {
      detail: {
        tags: ["Widget Thread"],
        description: "Get total message count for all threads in a widget",
        summary: "Get total message count for widget",
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
        }),
      }),
      response: {
        200: t.Object({
          success: t.Boolean(),
          data: t.Number(),
        }),
        400: t.Object({
          success: t.Boolean(),
          message: t.String(),
        }),
      },
    },
  );
};
