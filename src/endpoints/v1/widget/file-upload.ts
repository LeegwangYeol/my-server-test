import { openai } from "@/lib/ai/openai";
import { sendDiscordWebhook } from "@/src/utils/log/discord-logger";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";
import { toFile } from "openai/uploads";

export const v1WidgetFileUpload = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/file/upload",
    async ({ body, cookie, request }) => {
      const { files } = body;
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 파일을 Uint8Array로 변환
      const uploadedFiles: { name: string; id: string; size: number }[] = [];

      /**
       * @todo: promise.all로 최적화
       */
      for (const file of files) {
        // * 파일을 Uint8Array로 변환
        const buffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(buffer);
        const readableStream = new ReadableStream({
          start(controller) {
            controller.enqueue(uint8Array);
            controller.close();
          },
        });
        const convertedFile = await toFile(readableStream, file.name);

        // * Open A.I에 파일 업로드
        const { id: fileId } = await openai.files.create({
          file: convertedFile,
          purpose: "assistants",
        });

        uploadedFiles.push({ name: file.name, id: fileId, size: file.size });

        sendDiscordWebhook(
          `🔖 파일이 업로드됐습니다.\n> ${user.phone_number} 님이 ${file.name} ${(
            file.size /
            (1024 * 1024)
          ).toFixed(2)} MB 파일을 업로드했습니다.\n> 파일 ID:${fileId}`,
          request,
        );
      }

      return {
        success: true,
        message: "파일이 업로드되었습니다.",
        files: uploadedFiles,
      };
    },
    {
      detail: {
        tags: ["Widget"],
        description: "Upload a file for A.I to reference in the response.",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        files: t.Files({
          description: "File to be referenced by A.I",
          error: "File is required",
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
        files: t.Optional(
          t.Array(
            t.Object({
              name: t.String(),
              id: t.String(),
              size: t.Number(),
            }),
          ),
        ),
      }),
    },
  );
};
