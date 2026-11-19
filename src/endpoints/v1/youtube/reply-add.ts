import { Elysia, t } from "elysia";
import { google } from "googleapis";
import {
  executeYoutubeWithRetry,
  handleYoutubeError,
  sanitizeYoutubeAccessToken,
} from "./yt-client";

// 타입 단언을 사용하여 타입 오류 해결
export const v1Reply = (app: any) => {
  app.post(
    "/reply",
    async ({ body, set }: { body: any; set: any }) => {
      const parentId = String(body?.parentId ?? "").trim();
      const text = String(body?.text ?? "").trim();
      const accessToken = sanitizeYoutubeAccessToken(body?.accessToken);

      if (!parentId || parentId.length > 256 || /[\s\x00-\x1f\x7f]/.test(parentId)) {
        set.status = 400;
        return {
          success: false,
          message: "유효한 parentId 값이 제공되지 않았습니다.",
        };
      }
      if (!text || text.length > 10000) {
        set.status = 400;
        return {
          success: false,
          message: "댓글 내용이 제공되지 않았습니다.",
        };
      }
      if (!accessToken) {
        set.status = 400;
        return {
          success: false,
          message: "유효한 accessToken 값이 제공되지 않았습니다.",
        };
      }

      try {
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: accessToken });

        const youtube = google.youtube({
          version: "v3",
          auth: oauth2Client,
          timeout: 10_000,
        });

        const response = await executeYoutubeWithRetry(
          () =>
            youtube.comments.insert({
              part: ["snippet"],
              requestBody: {
                snippet: {
                  textOriginal: text,
                  parentId: parentId,
                },
              },
            }),
          1,
          true,
        );

        return {
          success: true,
          message: "답글이 성공적으로 등록되었습니다.",
          data: {
            comment: response.data,
          },
        };
      } catch (error: any) {
        return handleYoutubeError(
          "reply",
          error,
          set,
          "답글 작성 중 오류가 발생하였습니다.",
        );
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
        429: t.Object({
          success: t.Boolean(),
          message: t.String(),
        }),
      },
    },
  );
};
