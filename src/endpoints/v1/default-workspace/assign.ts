import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1DefaultWorkspaceAssign = async (
  app: Elysia<"/v1/default-workspace">,
) => {
  app.post(
    "/assign",
    async ({ body, cookie }) => {
      try {
        const { workspaceId } = body;
        const user = await getUser({ body, cookie });

        if (!user) {
          return {
            success: false,
            message: "로그인 한 이용자만 사용가능합니다.",
          };
        }

        // 워크스페이스 존재 확인
        const { data: workspace } = await supabaseClient
          .from("llami_workspace")
          .select("*")
          .eq("id", workspaceId)
          .eq("is_deleted", false)
          .limit(1)
          .maybeSingle();

        if (!workspace) {
          return {
            success: false,
            message: "존재하지 않는 워크스페이스입니다.",
          };
        }

        // 워크스페이스 멤버 확인
        const { data: member } = await supabaseClient
          .from("llami_workspace_member")
          .select("*")
          .eq("workspace_id", workspaceId)
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();

        if (workspace.owner !== user.id && !member) {
          return {
            success: false,
            message:
              "워크스페이스 소유자나 멤버만 Default Workspace로 지정할 수 있습니다.",
          };
        }

        // 사용자의 기존 Default Workspace 업데이트 또는 생성
        const { data: result, error } = await supabaseClient
          .from("llami_default_workspace")
          .upsert(
            {
              user_id: user.id,
              workspace_id: workspaceId,
              updated_at: new Date().toISOString(),
            },
            {
              onConflict: "user_id",
            },
          )
          .select()
          .limit(1)
          .maybeSingle();

        if (error) {
          console.error("Default Workspace 지정 중 오류 발생:", error);
          return {
            success: false,
            message: "Default Workspace 지정 중 오류가 발생했습니다.",
          };
        }

        return {
          success: true,
          message: "Default Workspace가 성공적으로 지정되었습니다.",
          data: result,
        };
      } catch (error) {
        console.error("Default Workspace 지정 중 오류 발생:", error);
        return {
          success: false,
          message: "Default Workspace 지정 중 오류가 발생했습니다.",
        };
      }
    },
    {
      body: t.Object({
        accessToken: t.String({
          description: "Access Token",
          error: "Access token is required",
        }),
        workspaceId: t.String({
          description: "Workspace ID",
          error: "Workspace ID is required",
        }),
      }),
      detail: {
        tags: ["Default Workspace"],
        description: "워크스페이스를 Default Workspace로 지정합니다.",
      },
    },
  );
};
