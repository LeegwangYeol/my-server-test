import { Elysia, t } from "elysia";
import { google } from "googleapis";
import {
  executeYoutubeWithRetry,
  handleYoutubeError,
  sanitizeYoutubeAccessToken,
} from "./yt-client";

const UPLOADS_CACHE_MAX = 500;
const UPLOADS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const channelUploadsCache = new Map<
  string,
  { playlistId: string; expiresAt: number }
>();
const inflightUploadsLookups = new Map<string, Promise<string | undefined>>();

function getCachedUploadsPlaylistId(handleKey: string): string | undefined {
  const entry = channelUploadsCache.get(handleKey);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    channelUploadsCache.delete(handleKey);
    return undefined;
  }
  channelUploadsCache.delete(handleKey);
  channelUploadsCache.set(handleKey, entry);
  return entry.playlistId;
}

function setCachedUploadsPlaylistId(handleKey: string, playlistId: string): void {
  if (channelUploadsCache.has(handleKey)) {
    channelUploadsCache.delete(handleKey);
  } else if (channelUploadsCache.size >= UPLOADS_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of channelUploadsCache.entries()) {
      if (v.expiresAt <= now) channelUploadsCache.delete(k);
    }
    if (channelUploadsCache.size >= UPLOADS_CACHE_MAX) {
      const oldest = channelUploadsCache.keys().next().value;
      if (oldest !== undefined) channelUploadsCache.delete(oldest);
    }
  }
  channelUploadsCache.set(handleKey, {
    playlistId,
    expiresAt: Date.now() + UPLOADS_CACHE_TTL_MS,
  });
}

export function clearChannelUploadsCache(): void {
  channelUploadsCache.clear();
  inflightUploadsLookups.clear();
}

// 타입 단언을 사용하여 타입 오류 해결
export const v1VideoList = (app: any) => {
  app.post(
    "/video/list",
    async ({ body, set }: { body: any; set: any }) => {
      const { maxResults, pageToken } = body;
      const handle = String(body?.handle ?? "").trim();
      const accessToken = sanitizeYoutubeAccessToken(body?.accessToken);

      if (!handle || handle.length > 128 || /[\s\x00-\x1f\x7f]/.test(handle)) {
        set.status = 400;
        return {
          success: false,
          message: "유효한 handle 값이 제공되지 않았습니다.",
        };
      }
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

        // 핸들을 기준으로 채널 업로드 플레이리스트 ID 가져오기 (불변 ID이므로 10분 LRU 캐시 적용해 페이지네이션 N+1 호출 제거)
        const normalizedHandleKey = (
          handle.startsWith("@") ? handle : `@${handle}`
        ).toLowerCase();
        let uploadsPlaylistId = getCachedUploadsPlaylistId(normalizedHandleKey);

        if (!uploadsPlaylistId) {
          const inflightKey = `${normalizedHandleKey}\0${accessToken}`;
          let lookupPromise = inflightUploadsLookups.get(inflightKey);
          if (!lookupPromise) {
            lookupPromise = (async () => {
              const isHandleFormat = handle.startsWith("@");
              let channelResponse = await executeYoutubeWithRetry(() =>
                youtube.channels.list(
                  isHandleFormat
                    ? { part: ["contentDetails"], forHandle: handle }
                    : { part: ["contentDetails"], forUsername: handle },
                ),
              );

              if (!channelResponse.data.items?.length && !isHandleFormat) {
                channelResponse = await executeYoutubeWithRetry(() =>
                  youtube.channels.list({
                    part: ["contentDetails"],
                    forHandle: `@${handle}`,
                  }),
                );
              }

              const resolvedId =
                channelResponse.data.items?.[0]?.contentDetails?.relatedPlaylists
                  ?.uploads ?? undefined;

              if (resolvedId) {
                setCachedUploadsPlaylistId(normalizedHandleKey, resolvedId);
              }
              return resolvedId;
            })().finally(() => {
              if (inflightUploadsLookups.get(inflightKey) === lookupPromise) {
                inflightUploadsLookups.delete(inflightKey);
              }
            });
            inflightUploadsLookups.set(inflightKey, lookupPromise);
          }
          uploadsPlaylistId = await lookupPromise;
        }

        if (!uploadsPlaylistId) {
          set.status = 400;
          return {
            success: false,
            message: "업로드 플레이리스트 ID를 가져올 수 없습니다.",
          };
        }

        // maxResults 처리 (기본값: 50, 허용 범위: 0~50, 실수 입력 시 정수 절삭)
        let max = 50;
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

        // 업로드 플레이리스트에서 동영상 리스트 가져오기
        const response = await executeYoutubeWithRetry(() =>
          youtube.playlistItems.list({
            part: ["snippet", "contentDetails"],
            playlistId: uploadsPlaylistId,
            maxResults: max,
            pageToken: cleanPageToken,
          }),
        );

        return {
          success: true,
          message: "채널의 동영상 목록을 성공적으로 가져왔습니다.",
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
          "video/list",
          error,
          set,
          "채널 동영상 조회 중 오류가 발생하였습니다.",
        );
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
          t.Union([t.String(), t.Number()], {
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
