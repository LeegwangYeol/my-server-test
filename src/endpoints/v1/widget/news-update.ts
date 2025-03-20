import { uploadImageFile } from "@/lib/storage/r2Client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";

export const v1UpdateNews = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/update/news",
    async ({ body, cookie }) => {
      const {
        newsId,
        newsTitle,
        newsContent,
        isDeleted,
        ogImageUrl,
        widgetId,
      } = body;

      const user = await getUser({ body, cookie });

      if (!user) {
        throw new Error("로그인 한 이용자만 사용가능합니다.");
      }

      if (newsId) {
        await supabaseClient.from("llami_news").upsert({
          id: newsId,
          news_title: newsTitle.trim(),
          news_content: newsContent.trim(),
          og_image: ogImageUrl,
          is_deleted: isDeleted,
          widget_id: widgetId,
          user_id: user.id,
        });
      } else {
        await supabaseClient.from("llami_news").upsert({
          news_title: newsTitle.trim(),
          news_content: newsContent.trim(),
          og_image: ogImageUrl,
          is_deleted: isDeleted,
          widget_id: widgetId,
          user_id: user.id,
        });
      }

      return {
        success: true,
        message: "뉴스 업로드 성공",
      };
    },
    {
      detail: {
        tags: ["Widget News"],
        description: "Widget News Update",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        newsId: t.Optional(
          t.Nullable(
            t.String({
              description: "News ID",
              error: "News ID is required",
              minLength: 1,
              maxLength: 10000,
            }),
          ),
        ),
        newsTitle: t.String({
          description: "News title",
          error: "뉴스 제목은 100자를 초과할 수 없습니다.",
          minLength: 1,
          maxLength: 100,
        }),
        newsContent: t.String({
          description: "News content",
          error: "뉴스 내용을 입력해주세요.",
          minLength: 1,
          maxLength: 100000,
        }),
        ogImageUrl: t.Optional(
          t.Nullable(
            t.String({
              description: "OG Image",
              error: "OG Image is required",
              minLength: 1,
              maxLength: 1000,
            }),
          ),
        ),
        isDeleted: t.Boolean({
          description: "Is deleted",
          error: "Is deleted is required",
        }),
        widgetId: t.String({
          description: "Widget ID",
          error: "위젯을 꼭 선택해주세요.",
          minLength: 1,
          maxLength: 100,
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
