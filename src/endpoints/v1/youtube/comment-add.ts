import { Elysia, t } from "elysia";
import { google } from "googleapis";

// 타입 단언을 사용하여 타입 오류 해결
export const v1Comment = (app: any) => {
  app.post(
    "/comment",
    async ({ body }: { body: any }) => {
      const { accessToken, videoId, commentText } = body;

      try {
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: accessToken });

        const youtube = google.youtube({
          version: "v3",
          auth: oauth2Client,
        });

        const response = await youtube.commentThreads.insert({
          part: ["snippet"],
          requestBody: {
            snippet: {
              videoId,
              topLevelComment: {
                snippet: {
                  textOriginal: commentText,
                },
              },
            },
          },
        });

        return {
          code: 200,
          success: true,
          message: "댓글이 성공적으로 작성되었습니다.",
          data: {
            id: response.data.id || "",
            snippet: {
              videoId: response.data.snippet?.videoId || "",
              topLevelComment: {
                snippet: {
                  textOriginal:
                    response.data.snippet?.topLevelComment?.snippet
                      ?.textOriginal || "",
                  publishedAt:
                    response.data.snippet?.topLevelComment?.snippet
                      ?.publishedAt || "",
                  updatedAt:
                    response.data.snippet?.topLevelComment?.snippet
                      ?.updatedAt || "",
                },
              },
            },
          },
        };
      } catch (error: any) {
        console.error("YouTube comment error:", error);
        return {
          code: 400,
          success: false,
          message: error?.message || "댓글 작성 중 오류가 발생했습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["YouTube"],
        description: "YouTube 동영상에 댓글을 작성합니다.",
      },
      body: t.Object({
        accessToken: t.String({
          description: "YouTube OAuth2 Access Token",
          error: "YouTube Access Token이 필요합니다.",
          minLength: 1,
        }),
        videoId: t.String({
          description: "YouTube Video ID",
          error: "YouTube 비디오 ID가 필요합니다.",
          minLength: 1,
          maxLength: 100,
        }),
        commentText: t.String({
          description: "댓글 내용",
          error: "댓글 내용이 필요합니다.",
          minLength: 1,
          maxLength: 10000,
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
          data: t.Optional(
            t.Object({
              id: t.String(),
              snippet: t.Object({
                videoId: t.String(),
                topLevelComment: t.Object({
                  snippet: t.Object({
                    textOriginal: t.String(),
                    publishedAt: t.String(),
                    updatedAt: t.String(),
                  }),
                }),
              }),
            }),
          ),
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
