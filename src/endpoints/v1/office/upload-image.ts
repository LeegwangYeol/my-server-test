import { uploadImageFile } from "@/lib/storage/r2Client";
import { Elysia, t } from "elysia";
import { checkPrimaryApiKey } from "@/lib/api-key";

export const v1OfficeUploadImage = async (app: Elysia<"/v1/office">) => {
  app.post(
    "/upload-image",
    async ({ body }) => {
      const { apiKey, image, imageUrl, folder } = body;
      if (!checkPrimaryApiKey(apiKey)) {
        throw new Error("Invalid API key");
      }

      // * 이미지 파일이나 URL 중 하나는 반드시 있어야 함
      if (!image && !imageUrl) {
        throw new Error("Image or Image URL is required");
      }

      // * 이미지 버퍼
      let buffer: ArrayBuffer | null = null;

      // * 이미지 파일을 ArrayBuffer로 변환
      if (image) buffer = await image.arrayBuffer();

      // * 이미지 URL을 ArrayBuffer로 변환
      if (imageUrl) {
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error("Image URL fetch failed");
        }
        buffer = await response.arrayBuffer();
      }

      if (!buffer) {
        throw new Error("Image buffer has not been created");
      }

      // * 이미지 업로드
      try {
        const url = await uploadImageFile({
          buffer,
          folder,
          compress: false,
        });

        return {
          success: true,
          message: "파일 업로드 성공",
          url,
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
        tags: ["Office"],
        description: "Image Upload",
      },
      body: t.Object({
        apiKey: t.String({
          description: "LLAMI SaaS API key",
          error: "API key is required",
          minLength: 1,
          maxLength: 100,
        }),
        image: t.Optional(
          t.File({
            description: "Image File",
            error: "Image File is required",
            type: ["image/png", "image/jpg", "image/jpeg"],
          }),
        ),
        imageUrl: t.Optional(
          t.String({
            description: "Image URL",
            error: "Image URL is required",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
        folder: t.String({
          description: "Image Folder",
          error: "Folder is required",
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
        url: t.Optional(
          t.String({
            description: "Image Path",
            error: "Image Path is required",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
      }),
    },
  );
};
