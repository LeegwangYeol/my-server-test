import { Elysia, t } from "elysia";
import { google } from "googleapis";
import {
  executeYoutubeWithRetry,
  handleYoutubeError,
  sanitizeYoutubeAccessToken,
} from "./yt-client";

// 타입 단언을 사용하여 타입 오류 해결
export const v1ChannelInfo = (app: any) => {
  app.post(
    "/channel/info",
    async ({ body, set }: { body: any; set: any }) => {
      const { maxResults, pageToken } = body;
      const accessToken = sanitizeYoutubeAccessToken(body?.accessToken);

      if (!accessToken) {
        set.status = 400;
        return {
          success: false,
          message: "유효한 accessToken 값이 제공되지 않았습니다.",
        };
      }
      const trimmedPageToken = typeof pageToken === "string" ? pageToken.trim() : "";
      if (
        trimmedPageToken.length > 512 ||
        (trimmedPageToken.length > 0 && /[\s\x00-\x1f\x7f]/.test(trimmedPageToken))
      ) {
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

        // maxResults 처리 (기본값: 5, 허용 범위: 0~50, 실수 입력 시 정수 절삭)
        let max = 5;
        if (maxResults !== undefined && maxResults !== null && maxResults !== "") {
          const parsed =
            typeof maxResults === "number"
              ? Number.isFinite(maxResults)
                ? Math.trunc(maxResults)
                : NaN
              : parseInt(String(maxResults), 10);
          if (!isNaN(parsed) && parsed >= 0 && parsed <= 50) {
            max = parsed;
          }
        }

        const cleanPageToken =
          typeof pageToken === "string" && pageToken.trim()
            ? pageToken.trim()
            : undefined;

        const response = await executeYoutubeWithRetry(() =>
          youtube.channels.list({
            part: ["snippet", "contentDetails", "statistics"],
            mine: true,
            maxResults: max,
            pageToken: cleanPageToken,
          }),
        );

        return {
          success: true,
          message: "채널 정보를 성공적으로 가져왔습니다.",
          data: {
            items: response.data.items || [],
            nextPageToken: response.data.nextPageToken ?? undefined,
            pageInfo: {
              totalResults: response.data.pageInfo?.totalResults ?? 0,
              resultsPerPage: response.data.pageInfo?.resultsPerPage ?? max,
            },
          },
        };
      } catch (error: any) {
        return handleYoutubeError(
          "channel/info",
          error,
          set,
          "채널 정보 조회 중 오류가 발생하였습니다.",
        );
      }
    },
    {
      detail: {
        tags: ["YouTube"],
        description: "인증된 사용자의 YouTube 채널 정보를 조회합니다.",
      },
      body: t.Object({
        accessToken: t.String({
          description: "YouTube Access Token",
          error: "Access Token is required",
        }),
        maxResults: t.Optional(
          t.Union([t.String(), t.Number()], {
            description: "Maximum results per page (0-50)",
            error: "maxResults must be between 0 and 50",
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
            items: t.Array(t.Any()),
            nextPageToken: t.Optional(t.String()),
            pageInfo: t.Optional(
              t.Object({
                totalResults: t.Number(),
                resultsPerPage: t.Number(),
              }),
            ),
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
