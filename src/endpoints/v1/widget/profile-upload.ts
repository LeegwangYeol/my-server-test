import { uploadImageFile } from "@/lib/storage/r2Client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetProfileUpload = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/profile/upload",
    async ({ body, cookie }) => {
      const { profileImage } = body;
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 이미지 파일을 ArrayBuffer로 변환
      const buffer = await profileImage.arrayBuffer();

      // * 이미지 업로드
      try {
        const profileUrl = await uploadImageFile({
          buffer,
          folder: "widget-profile-v1",
          compress: false,
        });

        return {
          success: true,
          message: "파일 업로드 성공",
          profileUrl,
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
        description: "A.I Profile Image Upload",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        profileImage: t.File({
          description: "Profile Image File",
          error: "Profile Image File is required",
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
        profileUrl: t.Optional(
          t.String({
            description: "Profile Image Path",
            error: "Profile Image Path is required",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
      }),
    },
  );
};
