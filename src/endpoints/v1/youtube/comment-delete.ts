import { Elysia, t } from "elysia";
import { google } from "googleapis";

export const v1CommentDelete = (app: Elysia<"/v1/youtube">) => {
  app.post(
    "/comment/delete",
    async ({ body }) => {
      const { commentId, accessToken } = body;

      if (!commentId) {
        return {
          success: false,
          message: "댓글 ID가 제공되지 않았습니다.",
        };
      }
      if (!accessToken) {
        return {
          success: false,
          message: "accessToken 값이 제공되지 않았습니다.",
        };
      }

      try {
        // OAuth2 클라이언트 생성 및 accessToken 설정
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: accessToken });

        // YouTube API 클라이언트 생성
        const youtube = google.youtube({
          version: "v3",
          auth: oauth2Client,
        });

        // 댓글 삭제 요청 - 삭제 성공 시 HTTP 204(No Content) 응답이 발생함
        await youtube.comments.delete({
          id: commentId,
        });

        return {
          success: true,
          message: "댓글이 성공적으로 삭제되었습니다.",
        };
      } catch (error: any) {
        console.error("YouTube 댓글 삭제 에러:", error);
        return {
          success: false,
          message: error?.message || "댓글 삭제 중 오류가 발생했습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["YouTube"],
        description: "유튜브 나의 채널 영상의 댓글 혹은 답글을 삭제합니다.",
      },
      body: t.Object({
        commentId: t.String({
          description: "삭제할 댓글(혹은 답글) ID",
          error: "댓글(답글) ID가 필요합니다.",
          minLength: 1,
        }),
        accessToken: t.String({
          description: "YouTube OAuth2 Access Token",
          error: "accessToken 값이 필요합니다.",
          minLength: 1,
        }),
      }),
      response: {
        200: t.Object({
          success: t.Boolean({
            description: "성공 여부",
          }),
          message: t.String({
            description: "응답 메시지",
            minLength: 1,
            maxLength: 1000,
          }),
        }),
        400: t.Object({
          success: t.Boolean(),
          message: t.String(),
        }),
        401: t.Object({
          success: t.Boolean(),
          message: t.String(),
        }),
      },
    },
  );
};
