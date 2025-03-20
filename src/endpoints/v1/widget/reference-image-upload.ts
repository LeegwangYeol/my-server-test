import { uploadImageFile } from "@/lib/storage/r2Client";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetReferenceImageUpload = async (
  app: Elysia<"/v1/widget">,
) => {
  app.post(
    "/reference-image/upload",
    async ({ body, cookie }) => {
      const { image } = body;

      // 사용자 인증
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // 이미지 파일을 ArrayBuffer로 변환
      const buffer = await image.arrayBuffer();

      // 이미지 업로드
      try {
        const imageUrl = await uploadImageFile({
          buffer,
          folder: "widget-reference-image-v1",
          compress: false,
        });

        return {
          success: true,
          message: "이미지 업로드 성공",
          imageUrl,
        };
      } catch (error: any) {
        console.error("Image upload failed:", error.message);
        return {
          success: false,
          message: "이미지 업로드가 실패했습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["Widget Reference Image"],
        description: "위젯의 참조 이미지를 업로드합니다.",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "액세스 토큰",
            error: "Access Token is required",
          }),
        ),
        image: t.File({
          description: "업로드할 이미지 파일",
          error: "Image file is required",
          type: ["image/png", "image/jpg", "image/jpeg"],
        }),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "성공 여부",
        }),
        message: t.Optional(
          t.String({
            description: "메시지",
          }),
        ),
        imageUrl: t.Optional(
          t.String({
            description: "이미지 URL",
          }),
        ),
      }),
    },
  );
};
