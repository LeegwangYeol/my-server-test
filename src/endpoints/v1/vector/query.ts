import { voyage } from "@/lib/ai/voyage";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1VectorFileQuery = async (app: Elysia<"/v1/vector">) => {
  app.post(
    "/file/query",
    async ({ body, cookie }) => {
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      const { query, widgetId } = body;

      try {
        const embedding = await voyage.embeddings({
          model: "voyage-3-lite",
          texts: [query],
        });

        if (embedding.object === "error") {
          console.error(`Voyage API error: ${embedding.detail}`);
          return {
            success: false,
            message: "내부 API 오류.",
          };
        }

        const { data: embeddingData } = await supabaseClient
          .rpc("llami_vector_file_embeddings_match", {
            query_model: "voyage-3-lite",
            query_embedding: JSON.stringify(embedding.data[0].embedding),
            match_threshold: 0.5,
            match_count: 200,
          })
          .eq("widget_id", widgetId);

        if (!embeddingData) {
          return {
            success: false,
            message: "존재하지 않는 위젯입니다.",
          };
        }

        return {
          success: true,
          results: embeddingData.map((embedding) => ({
            text: embedding.text,
            file: {
              url: embedding.url,
              fileName: embedding.file_name,
              fileType: embedding.file_type,
            },
          })),
        };
      } catch (error) {
        console.error(error);
        return {
          success: false,
          message: "쿼리 처리 중 오류가 발생하였습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["Vector"],
        description: "Query Vector File",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        query: t.String({
          description: "Query",
          error: "Query is required",
          minLength: 1,
          maxLength: 1000,
        }),
        widgetId: t.String({
          description: "Widget ID",
          error: "Widget ID is required",
          minLength: 1,
          maxLength: 100,
        }),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "Success",
        }),
        results: t.Optional(
          t.Array(
            t.Object({
              text: t.String({
                description: "Queried Text",
              }),
              file: t.Object({
                url: t.String({
                  description: "File URL",
                }),
                fileName: t.String({
                  description: "File Name",
                }),
                fileType: t.String({
                  description: "File Type",
                }),
              }),
            }),
          ),
        ),
        message: t.Optional(
          t.String({
            description: "Message",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
      }),
    },
  );
};
