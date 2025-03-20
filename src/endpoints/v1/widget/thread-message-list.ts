// thread-message-list.ts

import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetThreadMessageList = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/thread/message/list",
    async ({ body, cookie }) => {
      const { threadId } = body;

      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용 가능합니다.",
        };
      }

      // * 스레드 정보 확인
      const { data: thread, error: threadError } = await supabaseClient
        .from("llami_widget_thread")
        .select("*")
        .eq("id", threadId)
        .limit(1)
        .maybeSingle();

      if (threadError || !thread) {
        return {
          success: false,
          message: "존재하지 않는 스레드입니다.",
        };
      }

      /**
       * @todo: 스레드에 대한 접근 권한 확인 (생략하지 않고 위젯 및 워크스페이스 검증 로직을 포함해야 함)
       */

      // * 스레드 메시지 목록 가져오기
      const { data: messages, error: messagesError } = await supabaseClient
        .from("llami_widget_thread_message")
        .select("*")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true });

      if (messagesError) {
        return {
          success: false,
          message: "메시지 목록을 가져오는 중 오류가 발생했습니다.",
        };
      }

      return {
        success: true,
        messages:
          messages.map((message) => ({
            id: message.id,
            thread_id: message.thread_id,
            content: message.content,
            created_at: message.created_at,
            is_user: message.is_user,
          })) || [],
      };
    },
    {
      detail: {
        tags: ["Widget Thread"],
        description: "Get messages of a thread",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        threadId: t.String({
          description: "Thread ID",
          error: "Thread ID is required",
        }),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "Success",
          error: "Success is required",
        }),
        messages: t.Optional(
          t.Array(
            t.Object({
              id: t.Number(),
              thread_id: t.Nullable(t.String()),
              content: t.Nullable(t.String()),
              is_user: t.Nullable(t.Boolean()),
              created_at: t.String(),
            }),
          ),
        ),
        message: t.Optional(
          t.String({
            description: "Error message",
          }),
        ),
      }),
    },
  );
};
