import { Elysia, t } from "elysia";
import { getUser } from "@/src/utils/get-user-from-token";
import { supabaseClient } from "../../../../lib/supabase/client";

export const v1ListApiKey = async (app: Elysia<"/v1/api-key">) => {
  app.post(
    "/list",
    async ({ body, cookie }) => {
      try {
        // 사용자 인증 확인
        const user = await getUser({ cookie, body });
        if (!user) {
          throw new Error("로그인 한 이용자만 사용가능합니다.");
        }

        // API 키 목록 조회
        const { data: apiKeys, error } = await supabaseClient
          .from("llami_api_key")
          .select("*")
          .eq("user_id", user.id)
          .is("deleted_at", null)
          .order("created_at", { ascending: false });

        if (error) {
          console.error("API 키 목록 조회 실패", error);
          throw new Error("API 키 목록 조회에 실패했습니다");
        }

        // 민감한 정보 제외하고 반환
        const sanitizedApiKeys = apiKeys.map((key) => ({
          id: key.id,
          label: key.label,
          created_at: key.created_at ?? new Date().toISOString(),
        }));

        return {
          success: true,
          data: { api_keys: sanitizedApiKeys },
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
        description: "List all API keys for the user",
      },
      body: t.Object({
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
            api_keys: t.Array(
              t.Object({
                id: t.String(),
                label: t.String(),
                created_at: t.String(),
              }),
            ),
          }),
        ),
      }),
    },
  );
};
