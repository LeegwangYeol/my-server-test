import { Elysia, t } from "elysia";
import { google } from "googleapis";

// 타입 단언을 사용하여 타입 오류 해결
export const v1VideoList = (app: any) => {
  app.post(
    "/video/list",
    async ({ body }) => {
      const { handle, accessToken, maxResults, pageToken } = body;

      try {
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: accessToken });

        const youtube = google.youtube({
          version: "v3",
          auth: oauth2Client,
        });

        // 핸들을 기준으로 채널 ID 가져오기
        const channelResponse = await youtube.channels.list({
          part: ["contentDetails"],
          forUsername: handle,
        });

        const uploadsPlaylistId =
          channelResponse.data.items?.[0]?.contentDetails?.relatedPlaylists
            ?.uploads;

        if (!uploadsPlaylistId) {
          return {
            success: false,
            message: "업로드 플레이리스트 ID를 가져올 수 없습니다.",
          };
        }

        // 업로드 플레이리스트에서 동영상 리스트 가져오기
        const response = await youtube.playlistItems.list({
          part: ["snippet", "contentDetails"],
          playlistId: uploadsPlaylistId,
          maxResults: maxResults ? parseInt(maxResults, 10) : 50,
          pageToken: pageToken || undefined,
        });

        return {
          success: true,
          message: "채널의 동영상 목록을 성공적으로 가져왔습니다.",
          data: {
            items: response.data.items,
            nextPageToken: response.data.nextPageToken,
            pageInfo: response.data.pageInfo,
          },
        };
      } catch (error: any) {
        console.error("YouTube 채널 동영상 조회 에러:", error);
        return {
          success: false,
          message:
            error?.message || "채널 동영상 조회 중 오류가 발생하였습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["YouTube"],
        description:
          "특정 YouTube 핸들(@handle)을 기준으로 채널의 모든 업로드된 동영상 목록을 반환합니다.",
      },
      body: t.Object({
        handle: t.String({
          description: "조회할 유튜브 채널 핸들(@handle) 입니다.",
          error: "채널 아이디가 필요합니다. ",
        }),
        accessToken: t.String({
          description: "YouTube OAuth2 Access Token",
          error: "Access Token이 필요합니다.",
        }),
        maxResults: t.Optional(
          t.String({
            description: "한 페이지당 최대 결과 수 (0-50)",
            error: "최대 페이지 결과수는 0 에서 50 사이입니다.",
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
