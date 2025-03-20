import { Elysia, t } from "elysia";
import { google } from "googleapis";

const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];

export const v1AuthCreate = (app: Elysia<"/v1/youtube">) => {
  app
    .post(
      "/auth/create",
      async ({ body }) => {
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
            pattern: "^[0-9]+-[a-zA-Z0-9]+\\.apps\\.googleusercontent\\.com$",
          }),
          clientSecret: t.String({
            description: "Google OAuth Client Secret",
            error: "Client Secret is required",
            pattern: "^GOCSPX-[a-zA-Z0-9]+$",
          }),
          redirectUri: t.String({
            description: "OAuth Redirect URI",
            error: "Redirect URI is required",
            pattern: "^https?://[\\w.-]+(?::\\d+)?/.*$",
          }),
        }),
        response: t.Object({
          success: t.Boolean(),
          message: t.String(),
          data: t.Object({
            url: t.String(),
          }),
        }),
      },
    )
    .get(
      "/auth/confirm",
      async ({ query }) => {
        const { code, state } = query;
        if (!code || !state) {
          return {
            success: false,
            message: "인증 코드 또는 상태 정보가 없습니다.",
          };
        }

        try {
          const authState = JSON.parse(
            Buffer.from(state as string, "base64").toString(),
          );
          const oauth2Client = new google.auth.OAuth2(
            authState.clientId,
            authState.clientSecret,
            authState.redirectUri,
          );

          const { tokens } = await oauth2Client.getToken(code as string);

          return {
            success: true,
            message: "인증이 완료되었습니다.",
            data: {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              expiryDate: tokens.expiry_date,
            },
          };
        } catch (error: any) {
          console.error("YouTube OAuth error:", error);
          return {
            success: false,
            message: error?.message || "인증 처리 중 오류가 발생했습니다.",
          };
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
        },
      },
    );
};
