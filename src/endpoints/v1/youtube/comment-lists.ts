import { Elysia, t } from "elysia";
import { google } from "googleapis";

export const v1CommentList = (app: Elysia<"/v1/youtube">) => {
  app.post(
    "/comment/list",
    async ({ body }) => {
      const { videoId, accessToken, maxResults, pageToken, textFormat, order } =
        body;

      if (!videoId) {
        return {
          success: false,
          message: "videoId 값이 제공되지 않았습니다.",
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

        // maxResults 처리 (기본값: 20, 허용 범위: 1~100)
        let max = 20;
        if (maxResults) {
          const parsed = parseInt(maxResults, 10);
          if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
            max = parsed;
          }
        }

        const response = await youtube.commentThreads.list({
          part: ["snippet", "replies"],
          videoId: videoId,
          maxResults: max,
          pageToken: pageToken,
          textFormat: textFormat || "html",
          order: order || "time",
        });

        return {
          success: true,
          message: "댓글 스레드 목록을 성공적으로 가져왔습니다.",
          data: {
            items: response.data.items,
            nextPageToken: response.data.nextPageToken,
            pageInfo: response.data.pageInfo,
          },
        };
      } catch (error: any) {
        console.error("YouTube 댓글 스레드 목록 조회 에러:", error);
        return {
          success: false,
          message:
            error?.message || "댓글 스레드 목록 조회 중 오류가 발생하였습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["YouTube"],
        description:
          "유튜브 동영상의 댓글 목록을 불러옵니다. 댓글에 대한 답글 리스트도 포함 됩니다.",
      },
      body: t.Object({
        videoId: t.String({
          description: "YouTube Video ID",
          error: "Video ID is required",
        }),
        accessToken: t.String({
          description: "YouTube Access Token",
          error: "Access Token is required",
        }),
        maxResults: t.Optional(
          t.String({
            description: "Maximum results per page (0-100)",
            error: "maxResults must be between 0 and 100",
          }),
        ),
        pageToken: t.Optional(
          t.String({
            description: "Page token for pagination",
          }),
        ),
        textFormat: t.Optional(
          t.Union([t.Literal("html"), t.Literal("plainText")], {
            description: "Comment text format (html or plainText)",
            error: "textFormat must be either 'html' or 'plainText'",
          }),
        ),
        order: t.Optional(
          t.Union([t.Literal("time"), t.Literal("relevance")], {
            description: "Comment ordering (time or relevance)",
            error: "order must be either 'time' or 'relevance'",
          }),
        ),
      }),
      response: {
        200: t.Object({
          success: t.Boolean(),
          message: t.String(),
          data: t.Object({
            items: t.Array(t.Any()),
            nextPageToken: t.Optional(t.String()),
            pageInfo: t.Object({
              totalResults: t.Number(),
              resultsPerPage: t.Number(),
            }),
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
