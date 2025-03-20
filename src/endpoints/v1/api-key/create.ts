import { Elysia, t } from "elysia";
import { getUser } from "@/src/utils/get-user-from-token";
import { supabaseClient } from "@/lib/supabase/client";
import { nanoid } from "nanoid";

export const v1CreateApiKey = async (app: Elysia<"/v1/api-key">) => {
  app.post(
    "/create",
    async ({ body, cookie }) => {
      try {
        // 사용자 인증 확인
        const user = await getUser({ cookie, body });
        if (!user) {
          throw new Error("로그인 한 이용자만 사용가능합니다.");
        }

        // API 키 생성
        const apiKey = `sk-${nanoid(32)}`; // 32자리 nanoid 생성

        // DB에 저장
        const { data: apiKeyData, error } = await supabaseClient
          .from("llami_api_key")
          .insert({
            user_id: user.id,
            user_key: apiKey,
            label: body.label,
            created_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (error) {
          console.error("API 키 생성 실패", error);
          throw new Error("API 키 생성에 실패했습니다");
        }

        // 성공 응답 (원본 키는 이때만 반환)
        return {
          success: true,
          data: {
            id: apiKeyData.id,
            api_key: apiKeyData.user_key,
            label: apiKeyData.label,
            created_at: apiKeyData.created_at ?? new Date().toISOString(),
          },
        };
      } catch (error) {
        return {
          success: false,
          message: (error as Error).message,
        };
      }
    },
    {
      detail: {
        tags: ["API Key"],
        description: "Create new API key",
      },
      body: t.Object({
        label: t.String({
          description: "API Key Label",
          error: "Label is required",
          minLength: 1,
          maxLength: 100,
        }),
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
      }),
      response: t.Object({
        success: t.Boolean(),
        message: t.Optional(t.String()),
        data: t.Optional(
          t.Object({
            id: t.String(),
            api_key: t.String(),
            label: t.String(),
            created_at: t.String(),
          }),
        ),
      }),
    },
  );
};
