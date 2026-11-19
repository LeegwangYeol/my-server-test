import { Elysia, t } from "elysia";
import { google } from "googleapis";
import {
  executeYoutubeWithRetry,
  handleYoutubeError,
  sanitizeYoutubeAccessToken,
} from "./yt-client";

// 타입 단언을 사용하여 타입 오류 해결
export const v1ReplyList = (app: any) => {
  app.post(
    "/reply/list",
    async ({ body, set }: { body: any; set: any }) => {
      const { maxResults, pageToken } = body;
      const parentId = String(body?.parentId ?? "").trim();
      const accessToken = sanitizeYoutubeAccessToken(body?.accessToken);

      if (!parentId || parentId.length > 256 || /[\s\x00-\x1f\x7f]/.test(parentId)) {
        set.status = 400;
        return {
          success: false,
          message: "유효한 댓글의 Id 값이 제공되지 않았습니다.",
        };
      }
      if (!accessToken) {
        set.status = 400;
        return {
          success: false,
          message: "유효한 accessToken 값이 제공되지 않았습니다.",
        };
      }
      if (typeof pageToken === "string" && pageToken.trim().length > 512) {
        set.status = 400;
        return {
          success: false,
          message: "유효하지 않은 pageToken 값입니다.",
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

        let max = 20;
        if (maxResults !== undefined && maxResults !== null && maxResults !== "") {
          const parsed =
            typeof maxResults === "number"
              ? Number.isFinite(maxResults)
                ? Math.trunc(maxResults)
                : NaN
              : parseInt(String(maxResults), 10);
          if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
            max = parsed;
          }
        }

        const cleanPageToken =
          typeof pageToken === "string" && pageToken.trim()
            ? pageToken.trim()
            : undefined;

        const response = await executeYoutubeWithRetry(() =>
          youtube.comments.list({
            part: ["snippet"], // part 파라미터 추가
            parentId: parentId,
            maxResults: max,
            pageToken: cleanPageToken,
          }),
        );

        return {
          success: true,
          message: "해당 댓글의 대댓글 리스트를 성공적으로 가져왔습니다.",
          data: {
            kind: response.data.kind ?? undefined,
            etag: response.data.etag ?? undefined,
            nextPageToken: response.data.nextPageToken ?? undefined,
            pageInfo: {
              totalResults: response.data.pageInfo?.totalResults ?? 0,
              resultsPerPage: response.data.pageInfo?.resultsPerPage ?? max,
            },
            items:
              response.data.items?.map((item) => ({
                kind: item.kind ?? undefined,
                etag: item.etag ?? undefined,
                id: item.id ?? "",
                snippet: {
                  authorDisplayName: item.snippet?.authorDisplayName ?? undefined,
                  authorProfileImageUrl: item.snippet?.authorProfileImageUrl ?? undefined,
                  authorChannelUrl: item.snippet?.authorChannelUrl ?? undefined,
                  authorChannelId: {
                    value: item.snippet?.authorChannelId?.value ?? undefined,
                  },
                  channelId: item.snippet?.channelId ?? undefined,
                  textDisplay: item.snippet?.textDisplay ?? undefined,
                  textOriginal: item.snippet?.textOriginal ?? undefined,
                  parentId: item.snippet?.parentId ?? undefined,
                  canRate: item.snippet?.canRate ?? undefined,
                  viewerRating: item.snippet?.viewerRating ?? undefined,
                  likeCount: item.snippet?.likeCount ?? undefined,
                  moderationStatus: item.snippet?.moderationStatus ?? undefined,
                  publishedAt: item.snippet?.publishedAt ?? undefined,
                  updatedAt: item.snippet?.updatedAt ?? undefined,
                },
              })) || [],
          },
        };
      } catch (error: any) {
        return handleYoutubeError(
          "reply/list",
          error,
          set,
          "댓글 목록 조회 중 오류가 발생하였습니다.",
        );
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
          t.Union([t.String(), t.Number()], {
            description: "한 페이지당 최대 결과 수 (1-100)",
            error: "maxResults는 1에서 100 사이의 값이어야 합니다.",
          }),
        ),
        pageToken: t.Optional(
          t.String({
            description: "Page token for pagination",
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
        429: t.Object({
          success: t.Boolean(),
          message: t.String(),
        }),
      },
    },
  );
};
