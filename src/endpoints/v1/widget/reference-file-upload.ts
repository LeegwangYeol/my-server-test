import { Elysia, t } from "elysia";
import { uploadFile } from "@/lib/storage/r2Client";
import { getUser } from "@/src/utils/get-user-from-token";

export const v1WidgetReferenceFileUpload = async (
  app: Elysia<"/v1/widget">,
) => {
  app.post(
    "/reference-file/upload",
    async ({ body, cookie }) => {
      const { files } = body;

      // 사용자 인증
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      try {
        const uploadedFiles = await Promise.all(
          files.map(async (file: File) => {
            const url = await uploadFile({
              buffer: await file.arrayBuffer(),
              folder: "vector-file-store-v1",
            });

            return {
              name: file.name,
              src: url,
              size: file.size,
            };
          }),
        );

        return {
          success: true,
          message: "파일 업로드 성공",
          files: uploadedFiles,
        };
      } catch (error: any) {
        console.error("File upload failed:", error.message);
        return {
          success: false,
          message: "파일 업로드가 실패했습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["Widget Reference File"],
        description: "위젯의 참조 파일을 업로드합니다.",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "액세스 토큰",
            error: "Access Token is required",
          }),
        ),
        files: t.Files({
          description: "업로드할 파일",
          error: "File is required",
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
        files: t.Optional(
          t.Array(
            t.Object({
              name: t.String({
                description: "File Name",
              }),
              src: t.String({
                description: "File URL",
              }),
              size: t.Number({
                description: "File Size",
              }),
            }),
          ),
        ),
      }),
    },
  );
};
