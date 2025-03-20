import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";

export const v1UpdateApiKey = async (app: Elysia<"/v1/api-key">) => {
  app.post(
    "/update",
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
          .eq("id", body.apiKey)
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

        // 라벨 업데이트
        const { data: updatedApiKey, error: updateError } = await supabaseClient
          .from("llami_api_key")
          .update({ label: body.label })
          .eq("id", body.apiKey)
          .eq("user_id", user.id)
          .select()
          .single();

        if (updateError) {
          console.error("API 키 라벨 수정 실패", updateError);
          throw new Error("API 키 라벨 수정에 실패했습니다");
        }

        return {
          success: true,
          message: "API 키 라벨이 수정되었습니다",
          data: {
            id: updatedApiKey.id,
            label: updatedApiKey.label,
            created_at: updatedApiKey.created_at ?? new Date().toISOString(),
          },
        };
      } catch (error) {
        console.error("API 키 라벨 수정 실패", error);
        return {
          success: false,
          message: (error as Error).message,
        };
      }
    },
    {
      detail: {
        tags: ["API Key"],
        description: "Update API key label",
      },
      body: t.Object({
        apiKey: t.String({
          description: "API Key ID to update",
          error: "API Key ID is required",
        }),
        label: t.String({
          description: "New API Key Label",
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
        message: t.String(),
        data: t.Optional(
          t.Object({
            id: t.String(),
            label: t.String(),
            created_at: t.String(),
          }),
        ),
      }),
    },
  );
};
