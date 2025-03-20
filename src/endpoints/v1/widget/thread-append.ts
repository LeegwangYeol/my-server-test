import { Elysia, t } from "elysia";
import { voyage } from "@/lib/ai/voyage";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";

export const v1WidgetThreadAppend = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/thread/append",
    async ({ body, cookie }) => {
      const { thread_id, content, is_user } = body;
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 스레드 정보 확인
      const { data: thread } = await supabaseClient
        .from("llami_widget_thread")
        .select("*")
        .eq("id", thread_id)
        .limit(1)
        .maybeSingle();

      // * 스레드 예외처리
      {
        if (!thread) {
          return {
            success: false,
            message: "존재하지 않는 스레드입니다.",
          };
        }
        if (thread.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 스레드입니다.",
          };
        }
      }

      // * 스레드 속한 위젯 정보 확인
      const { data: widget } = await supabaseClient
        .from("llami_widget")
        .select("*")
        .eq("id", thread.widget_id)
        .limit(1)
        .maybeSingle();

      // * 스레드 속한 위젯 예외처리
      {
        if (!widget) {
          return {
            success: false,
            message: "존재하지 않는 위젯의 스레드입니다.",
          };
        }
        if (widget.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 위젯의 스레드입니다.",
          };
        }
      }

      // * 메시지 임베딩
      const queryEmbedding = await voyage.embeddings({
        model: "voyage-3-lite",
        texts: [content],
      });

      // * 스레드 메시지 추가
      const response = await supabaseClient
        .from("llami_widget_thread_message")
        .insert({
          thread_id,
          content,
          is_user,
          embedding:
            queryEmbedding.object === "list"
              ? JSON.stringify(queryEmbedding.data[0].embedding)
              : null,
          model: "voyage-3-lite",
        })
        .select()
        .limit(1)
        .maybeSingle();

      await supabaseClient
        .from("llami_widget_thread")
        .update({
          updated_at: response.data?.created_at || new Date().toISOString(),
        })
        .eq("id", thread_id);

      {
        if (response.error) {
          console.error(response.error);
          return {
            success: false,
            message: "쓰레드 메시지 생성이 실패하였습니다.",
          };
        }
      }

      return {
        success: true,
        message: "스레드 메시지가 추가되었습니다.",
      };
    },
    {
      detail: {
        tags: ["Widget Thread"],
        description: "Append Thread Message",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        thread_id: t.String({
          description: "Thread ID",
          error: "Thread ID is required",
          minLength: 1,
          maxLength: 100,
        }),
        content: t.String({
          description: "Content",
          error: "Content is required",
        }),
        is_user: t.Boolean({
          description: "Is User",
          error: "Is User is required",
        }),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "Success",
          error: "Success is required",
        }),
        message: t.Optional(
          t.String({
            description: "Message",
            error: "Message is required",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
      }),
    },
  );
};
