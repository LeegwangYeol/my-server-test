import { uploadImageFile } from "@/lib/storage/r2Client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetCustomLogoUpload = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/custom-logo/upload",
    async ({ body, cookie }) => {
      const { logo } = body;
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 이미지 파일을 ArrayBuffer로 변환
      const buffer = await logo.arrayBuffer();

      // * 이미지 업로드
      try {
        const logoUrl = await uploadImageFile({
          buffer,
          folder: "widget-logo-v1",
          compress: false,
        });

        return {
          success: true,
          message: "파일 업로드 성공",
          logoUrl,
        };
      } catch (error: any) {
        console.error(error.message, "파일 업로드가 실패했습니다.");
        return {
          success: false,
          message: "파일 업로드가 실패했습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["Widget"],
        description: "Chatbot Logo Custom logo Upload",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        logo: t.File({
          description: "Chatbot Logo Image File",
          error: "Chatbot Logo Image File is required",
          type: ["image/png", "image/jpg", "image/jpeg"],
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
        logoUrl: t.Optional(
          t.String({
            description: "logo Image Path",
            error: "logo Image Path is required",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
      }),
    },
  );
};
