import { Elysia, t } from "elysia";
import { google } from "googleapis";

// 타입 단언을 사용하여 타입 오류 해결
export const v1ChannelInfo = (app: any) => {
  app.post(
    "/channel/info",
    async ({ body }: { body: any }) => {
      const { accessToken, maxResults, pageToken } = body;

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

        // maxResults 처리 (기본값: 5, 허용 범위: 0~50)
        let max = 5;
        if (maxResults) {
          const parsed = parseInt(maxResults, 10);
          if (!isNaN(parsed) && parsed >= 0 && parsed <= 50) {
            max = parsed;
          }
        }

        const response = await youtube.channels.list({
          part: ["snippet", "contentDetails", "statistics"],
          mine: true,
          maxResults: max,
          pageToken: pageToken,
        });

        return {
          success: true,
          message: "채널 정보를 성공적으로 가져왔습니다.",
          data: {
            items: response.data.items,
            nextPageToken: response.data.nextPageToken,
            pageInfo: response.data.pageInfo,
          },
        };
      } catch (error: any) {
        console.error("YouTube 채널 정보 조회 에러:", error);
        return {
          success: false,
          message: error?.message || "채널 정보 조회 중 오류가 발생하였습니다.",
        };
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
          t.String({
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
