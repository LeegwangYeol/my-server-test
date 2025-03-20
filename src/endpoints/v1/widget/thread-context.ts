import { Elysia, t } from "elysia";
import { voyage } from "@/lib/ai/voyage";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";

export const v1WidgetThreadContext = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/thread/context",
    async ({ body, cookie }) => {
      const { threadId, query } = body;

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

      const queryEmbedding = await voyage.embeddings({
        model: "voyage-3-lite",
        texts: [query],
      });

      if (queryEmbedding.object === "error") {
        return {
          success: false,
          message: "내부 오류가 발생하였습니다.",
        };
      }

      const { data: relevantMessages, error: relevantMessagesError } =
        await supabaseClient
          .rpc("llami_widget_thread_message_embeddings_match", {
            query_model: "voyage-3-lite",
            query_embedding: JSON.stringify(queryEmbedding.data[0].embedding),
            match_threshold: 0.5,
          })
          .eq("thread_id", threadId)
          .limit(5);

      if (
        relevantMessagesError ||
        !relevantMessages ||
        relevantMessages.length === 0
      ) {
        return {
          success: false,
          message: "메시지 목록을 가져오는 중 오류가 발생했습니다.",
        };
      }

      return {
        success: true,
        result: relevantMessages.map((message) => ({
          id: message.id!,
          thread_id: message.thread_id!,
          content: message.content!,
          created_at: message.created_at!,
          is_user: message.is_user!,
        })),
      };
    },
    {
      detail: {
        tags: ["Widget Thread"],
        description: "Get context of a thread",
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
        query: t.String({
          description: "Query",
          error: "Query is required",
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
          }),
        ),
        result: t.Optional(
          t.Array(
            t.Object({
              id: t.Number(),
              thread_id: t.String(),
              content: t.String(),
              created_at: t.String(),
              is_user: t.Boolean(),
            }),
          ),
        ),
      }),
    },
  );
};
