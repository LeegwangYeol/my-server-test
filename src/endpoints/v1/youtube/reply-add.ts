import { Elysia, t } from "elysia";
import { google } from "googleapis";

// 타입 단언을 사용하여 타입 오류 해결
export const v1Reply = (app: any) => {
  app.post(
    "/reply",
    async ({ body }: { body: any }) => {
      const { parentId, text, accessToken } = body;

      if (!parentId) {
        return {
          success: false,
          message: "parentId 값이 제공되지 않았습니다.",
        };
      }
      if (!text) {
        return {
          success: false,
          message: "댓글 내용이 제공되지 않았습니다.",
        };
      }
      if (!accessToken) {
        return {
          success: false,
          message: "accessToken 값이 제공되지 않았습니다.",
        };
      }

      try {
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: accessToken });

        const youtube = google.youtube({
          version: "v3",
          auth: oauth2Client,
        });

        const response = await youtube.comments.insert({
          part: ["snippet"],
          requestBody: {
            snippet: {
              textOriginal: text,
              parentId: parentId,
            },
          },
        });

        return {
          success: true,
          message: "답글이 성공적으로 등록되었습니다.",
          data: {
            comment: response.data,
          },
        };
      } catch (error: any) {
        console.error("YouTube 답글 작성 에러:", error);
        return {
          success: false,
          message: error?.message || "답글 작성 중 오류가 발생하였습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["YouTube"],
        description: "유튜브 댓글에 답글을 작성합니다.",
      },
      body: t.Object({
        parentId: t.String({
          description: "댓글 ID",
          error: "답글을 달아줄 댓글 ID가 필요합니다.",
        }),
        text: t.String({
          description: "답글 내용",
          error: "답글 내용이 필요합니다.",
          minLength: 1,
          maxLength: 10000,
        }),
        accessToken: t.String({
          description: "YouTube OAuth2 Access Token",
          error: "Access Token이 필요합니다.",
        }),
      }),
      response: {
        200: t.Object({
          success: t.Boolean(),
          message: t.String(),
          data: t.Object({
            comment: t.Any(),
          }),
        }),
        400: t.Object({
          success: t.Boolean(),
          message: t.String(),
        }),
      },
    },
  );
};
