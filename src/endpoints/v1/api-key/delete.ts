import { Elysia, t } from "elysia";
import { getUser } from "@/src/utils/get-user-from-token";
import { supabaseClient } from "../../../../lib/supabase/client";

export const v1DeleteApiKey = async (app: Elysia<"/v1/api-key">) => {
  app.post(
    "/delete",
    async ({ body, cookie }) => {
      try {
        // 사용자 인증 확인
        const user = await getUser({ cookie, body });
        if (!user) {
          throw new Error("로그인 한 이용자만 사용가능합니다.");
        }

        // API 키 존재 여부 및 소유권 확인
        const { data: apiKey, error: fetchError } = await supabaseClient
          .from("llami_api_key")
          .select("*")
          .eq("id", body.keyId)
          .eq("user_id", user.id)
          .is("deleted_at", null)
          .limit(1)
          .maybeSingle();

        if (fetchError) {
          console.error("API 키 조회 실패", fetchError);
          throw new Error("API 키 조회에 실패했습니다");
        }

        if (!apiKey) {
          throw new Error("API 키를 찾을 수 없습니다");
        }

        // Soft Delete 처리
        const { error: deleteError } = await supabaseClient
          .from("llami_api_key")
          .update({
            deleted_at: new Date().toISOString(),
          })
          .eq("id", body.keyId)
          .eq("user_id", user.id);

        if (deleteError) {
          console.error("API 키 삭제 실패", deleteError);
          throw new Error("API 키 삭제에 실패했습니다");
        }

        return {
          success: true,
          message: "API 키가 삭제되었습니다",
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
        description: "Delete an API key",
      },
      body: t.Object({
        keyId: t.String({
          description: "API Key ID to delete",
          error: "API Key ID is required",
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
        message: t.String(),
      }),
    },
  );
};
