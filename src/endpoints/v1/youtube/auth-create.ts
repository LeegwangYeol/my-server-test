import { Elysia, t } from "elysia";
import { google } from "googleapis";
import { executeYoutubeWithRetry, handleYoutubeError } from "./yt-client";

const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];
const CLIENT_ID_RE = /^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET_RE = /^GOCSPX-[a-zA-Z0-9_-]+$/;
const REDIRECT_URI_RE =
  /^https?:\/\/[\w.-]+(?::\d{1,5})?\/[^\s\\\x00-\x1f\x7f]*$/;

function isValidOAuthRedirectUri(raw: string): boolean {
  if (!raw || raw.length > 2048 || !REDIRECT_URI_RE.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (!parsed.hostname || parsed.username || parsed.password) return false;
    if (parsed.port) {
      const port = Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// 타입 단언을 사용하여 타입 오류 해결
export const v1AuthCreate = (app: any) => {
  app
    .post(
      "/auth/create",
      async ({ body, set }: { body: any; set: any }) => {
        if (!isValidOAuthRedirectUri(String(body?.redirectUri ?? "").trim())) {
          set.status = 400;
          return {
            success: false,
            message: "유효하지 않은 redirectUri 값입니다.",
          };
        }
        const oauth2Client = new google.auth.OAuth2(
          body.clientId,
          body.clientSecret,
          body.redirectUri,
        );

        const state = Buffer.from(
          JSON.stringify({
            clientId: body.clientId,
            clientSecret: body.clientSecret,
            redirectUri: body.redirectUri,
          }),
        ).toString("base64");

        const url = oauth2Client.generateAuthUrl({
          access_type: "offline",
          scope: YOUTUBE_SCOPES,
          state,
        });

        return {
          success: true,
          message: "인증 URL이 생성되었습니다.",
          data: { url },
        };
      },
      {
        detail: {
          tags: ["YouTube"],
          description: "YouTube OAuth2 인증 URL을 생성합니다.",
        },
        body: t.Object({
          clientId: t.String({
            description: "Google OAuth Client ID",
            error: "Client ID is required",
            maxLength: 512,
            pattern: "^[0-9]+-[a-zA-Z0-9_-]+\\.apps\\.googleusercontent\\.com$",
          }),
          clientSecret: t.String({
            description: "Google OAuth Client Secret",
            error: "Client Secret is required",
            maxLength: 512,
            pattern: "^GOCSPX-[a-zA-Z0-9_-]+$",
          }),
          redirectUri: t.String({
            description: "OAuth Redirect URI",
            error: "Redirect URI is required",
            maxLength: 2048,
            pattern: "^https?://[\\w.-]+(?::\\d{1,5})?/[^\\s\\\\\\x00-\\x1f\\x7f]*$",
          }),
        }),
        response: {
          200: t.Object({
            success: t.Boolean(),
            message: t.String(),
            data: t.Object({
              url: t.String(),
            }),
          }),
          400: t.Object({
            success: t.Boolean(),
            message: t.String(),
          }),
        },
      },
    )
    .get(
      "/auth/confirm",
      async ({ query, set }: { query: any; set: any }) => {
        const code = String(query?.code ?? "").trim();
        const state = String(query?.state ?? "").trim();
        if (
          !code ||
          code.length > 2048 ||
          /[\s\x00-\x1f\x7f]/.test(code) ||
          !state ||
          state.length > 4096
        ) {
          set.status = 400;
          return {
            success: false,
            message: "인증 코드 또는 상태 정보가 없습니다.",
          };
        }

        try {
          const authState = JSON.parse(
            Buffer.from(state, "base64").toString(),
          );
          const cid =
            typeof authState?.clientId === "string"
              ? authState.clientId.trim()
              : "";
          const csec =
            typeof authState?.clientSecret === "string"
              ? authState.clientSecret.trim()
              : "";
          const ruri =
            typeof authState?.redirectUri === "string"
              ? authState.redirectUri.trim()
              : "";

          if (
            !authState ||
            typeof authState !== "object" ||
            !cid ||
            cid.length > 512 ||
            !CLIENT_ID_RE.test(cid) ||
            !csec ||
            csec.length > 512 ||
            !CLIENT_SECRET_RE.test(csec) ||
            !isValidOAuthRedirectUri(ruri)
          ) {
            set.status = 400;
            return {
              success: false,
              message: "유효하지 않은 인증 상태(state) 정보입니다.",
            };
          }
          const oauth2Client = new google.auth.OAuth2({
            clientId: cid,
            clientSecret: csec,
            redirectUri: ruri,
            transporterOptions: { timeout: 10_000 },
          });

          const { tokens } = await executeYoutubeWithRetry(
            () => oauth2Client.getToken(code as string),
            1,
            true,
          );
          if (!tokens?.access_token) {
            set.status = 400;
            return {
              success: false,
              message: "유효한 액세스 토큰을 발급받지 못했습니다.",
            };
          }

          return {
            success: true,
            message: "인증이 완료되었습니다.",
            data: {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token ?? undefined,
              expiryDate: tokens.expiry_date ?? undefined,
            },
          };
        } catch (error: any) {
          return handleYoutubeError(
            "auth/confirm",
            error,
            set,
            "인증 처리 중 오류가 발생했습니다.",
          );
        }
      },
      {
        detail: {
          tags: ["YouTube"],
          description: "YouTube OAuth2 콜백을 처리합니다.",
        },
        query: t.Object({
          code: t.Optional(t.String()),
          state: t.Optional(t.String()),
        }),
        response: {
          200: t.Object({
            success: t.Boolean(),
            message: t.String(),
            data: t.Object({
              accessToken: t.String(),
              refreshToken: t.Optional(t.String()),
              expiryDate: t.Optional(t.Number()),
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
