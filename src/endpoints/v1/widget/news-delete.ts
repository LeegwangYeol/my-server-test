import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";

export const v1DeleteNews = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/delete/news",
    async ({ body, cookie }) => {
      const { newsId, isDeleted } = body;

      if (!newsId) {
        throw new Error("뉴스 ID가 없습니다.");
      }

      const user = await getUser({ body, cookie });

      if (!user) {
        throw new Error("로그인 한 이용자만 사용가능합니다.");
      }

      await supabaseClient.from("llami_news").upsert({
        id: newsId,
        is_deleted: isDeleted,
        user_id: user.id,
      });

      return {
        success: true,
        message: "뉴스 삭제 성공",
      };
    },
    {
      detail: {
        tags: ["Widget News"],
        description: "Widget News Delete",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        newsId: t.String({
          description: "News ID",
          error: "News ID is required",
          minLength: 1,
          maxLength: 10000,
        }),

        isDeleted: t.Boolean({
          description: "Is deleted",
          error: "Is deleted is required",
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
