import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";

export const v1ChatSetDefaultWorkspace = async (app: Elysia<"/v1/chat">) => {
  app.post(
    "/set-default-workspace",
    async ({ body, cookie }) => {
      const { workspaceId } = body;
      const user = await getUser({ body, cookie });

      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // 워크스페이스 정보 확인
      const { data: workspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", workspaceId)
        .eq("is_deleted", false)
        .maybeSingle();

      if (!workspace) {
        return {
          success: false,
          message: "존재하지 않는 워크스페이스입니다.",
        };
      }

      // 이전 기본 워크스페이스 해제
      await supabaseClient
        .from("llami_workspace")
        .update({ is_default: false })
        .eq("owner", user.id)
        .eq("is_default", true);

      // 새로운 기본 워크스페이스 설정
      const { error } = await supabaseClient
        .from("llami_workspace")
        .update({ is_default: true })
        .eq("id", workspaceId);

      if (error) {
        return {
          success: false,
          message: "기본 워크스페이스 설정 중 오류가 발생했습니다.",
        };
      }

      return {
        success: true,
        message: "기본 워크스페이스가 설정되었습니다.",
      };
    },
    {
      body: t.Object({
        accessToken: t.String({
          description: "Access Token",
          error: "Access Token is required",
        }),
        workspaceId: t.String({
          description: "Workspace ID",
          error: "Workspace ID is required",
        }),
      }),
      response: t.Object({
        success: t.Boolean(),
        message: t.String(),
      }),
    },
  );
};
