// reference-image-list.ts

import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetReferenceImageList = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/reference-image/list",
    async ({ body, cookie }) => {
      const { widgetId } = body;

      // 사용자 인증
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      if (!widgetId) {
        return {
          success: true,
          images: [],
        };
      }

      // 데이터베이스에서 이미지 가져오기
      const { data: images, error } = await supabaseClient
        .from("llami_widget_reference_image")
        .select("*")
        .eq("widget_id", widgetId)
        .eq("is_deleted", false)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Error fetching images:", error);
        return {
          success: false,
          message: "이미지 목록을 가져오는 중 오류가 발생했습니다.",
        };
      }

      return {
        success: true,
        images: images || [],
      };
    },
    {
      detail: {
        tags: ["Widget Reference Image"],
        description: "특정 위젯의 참조 이미지 목록을 가져옵니다.",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "액세스 토큰",
            error: "Access Token is required",
          }),
        ),
        widgetId: t.String({
          description: "위젯 ID",
          error: "Widget ID is required",
        }),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "성공 여부",
        }),
        images: t.Optional(
          t.Array(
            t.Object({
              id: t.String(),
              widget_id: t.String(),
              src: t.String(),
              description: t.String(),
              created_at: t.String(),
              updated_at: t.String(),
            }),
          ),
        ),
        message: t.Optional(
          t.String({
            description: "에러 메시지",
          }),
        ),
      }),
    },
  );
};
