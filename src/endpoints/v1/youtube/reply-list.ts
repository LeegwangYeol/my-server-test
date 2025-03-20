import { Elysia, t } from "elysia";
import { google } from "googleapis";

// 타입 단언을 사용하여 타입 오류 해결
export const v1ReplyList = (app: any) => {
  app.post(
    "/reply/list",
    async ({ body }) => {
      const { parentId, accessToken, maxResults } = body;

      if (!parentId) {
        return {
          success: false,
          message: "댓글의 Id 값이 제공되지 않았습니다.",
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

        let max = 20;
        if (maxResults) {
          const parsed = parseInt(maxResults, 10);
          if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
            max = parsed;
          }
        }

        const response = await youtube.comments.list({
          part: ["snippet"], // part 파라미터 추가
          parentId: parentId,
          maxResults: max,
        });

        return {
          success: true,
          message: "해당 댓글의 대댓글 리스트를 성공적으로 가져왔습니다.",
          data: {
            kind: response.data.kind,
            etag: response.data.etag,
            nextPageToken: response.data.nextPageToken,
            pageInfo: {
              totalResults: response.data.pageInfo?.totalResults,
              resultsPerPage: response.data.pageInfo?.resultsPerPage,
            },
            items:
              response.data.items?.map((item) => ({
                kind: item.kind,
                etag: item.etag,
                id: item.id,
                snippet: {
                  authorDisplayName: item.snippet?.authorDisplayName,
                  authorProfileImageUrl: item.snippet?.authorProfileImageUrl,
                  authorChannelUrl: item.snippet?.authorChannelUrl,
                  authorChannelId: {
                    value: item.snippet?.authorChannelId?.value,
                  },
                  channelId: item.snippet?.channelId,
                  textDisplay: item.snippet?.textDisplay,
                  textOriginal: item.snippet?.textOriginal,
                  parentId: item.snippet?.parentId,
                  canRate: item.snippet?.canRate,
                  viewerRating: item.snippet?.viewerRating,
                  likeCount: item.snippet?.likeCount,
                  moderationStatus: item.snippet?.moderationStatus,
                  publishedAt: item.snippet?.publishedAt,
                  updatedAt: item.snippet?.updatedAt,
                },
              })) || [],
          },
        };
      } catch (error: any) {
        console.error("YouTube 댓글 목록 조회 에러:", error);
        return {
          success: false,
          message: error?.message || "댓글 목록 조회 중 오류가 발생하였습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["YouTube"],
        description:
          "유튜브 답글 리스트를 불러옵니다. 댓글 ID로 해당 답글 리스트를 조회할 수 있습니다.",
      },
      body: t.Object({
        parentId: t.String({
          description: "댓글 ID",
          error: "댓글 ID가 필요합니다.",
        }),
        accessToken: t.String({
          description: "YouTube OAuth2 Access Token",
          error: "Access Token이 필요합니다.",
        }),
        maxResults: t.Optional(
          t.String({
            description: "한 페이지당 최대 결과 수 (1-100)",
            error: "maxResults는 1에서 100 사이의 값이어야 합니다.",
          }),
        ),
      }),
      response: {
        200: t.Object({
          success: t.Boolean(),
          message: t.String(),
          data: t.Object({
            items: t.Array(
              t.Object({
                id: t.String(),
                snippet: t.Object({
                  textDisplay: t.Optional(t.String()),
                  textOriginal: t.Optional(t.String()),
                  parentId: t.Optional(t.String()),
                  authorDisplayName: t.Optional(t.String()),
                  authorProfileImageUrl: t.Optional(t.String()),
                  authorChannelUrl: t.Optional(t.String()),
                  authorChannelId: t.Optional(t.Any()),
                  canRate: t.Optional(t.Boolean()),
                  likeCount: t.Optional(t.Number()),
                  publishedAt: t.Optional(t.String()),
                  updatedAt: t.Optional(t.String()),
                }),
              }),
            ),
            pageInfo: t.Optional(t.Any()),
            nextPageToken: t.Optional(t.String()),
            prevPageToken: t.Optional(t.String()),
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
