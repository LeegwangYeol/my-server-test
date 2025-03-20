import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1DefaultWorkspaceView = async (
  app: Elysia<"/v1/default-workspace">,
) => {
  app.post(
    "/view",
    async ({ body, cookie }) => {
      try {
        const user = await getUser({ body, cookie });

        if (!user) {
          return {
            success: false,
            message: "로그인 한 이용자만 사용가능합니다.",
          };
        }

        // Default Workspace 조회
        const { data: defaultWorkspace, error: defaultWorkspaceError } =
          await supabaseClient
            .from("llami_default_workspace")
            .select("*")
            .eq("user_id", user.id)
            .limit(1)
            .maybeSingle();

        if (defaultWorkspaceError) {
          console.error(
            "Default Workspace 조회 중 오류 발생:",
            defaultWorkspaceError,
          );

          return {
            success: false,
            message: "Default Workspace 조회 중 오류가 발생했습니다.",
          };
        }

        // 워크스페이스 정보 조회
        if (defaultWorkspace?.workspace_id) {
          const { data: workspace, error: workspaceError } =
            await supabaseClient
              .from("llami_workspace")
              .select("*")
              .eq("id", defaultWorkspace.workspace_id)
              .limit(1)
              .maybeSingle();

          if (workspaceError) {
            console.error("워크스페이스 조회 중 오류 발생:", workspaceError);
            return {
              success: false,
              message: "워크스페이스 조회 중 오류가 발생했습니다.",
            };
          }

          return {
            success: true,
            message: "Default Workspace가 성공적으로 조회되었습니다.",
            data: {
              ...defaultWorkspace,
              workspace,
            },
          };
        }

        const { data: workspace, error: workspaceError } = await supabaseClient
          .from("llami_workspace")
          .select("*")
          .eq("owner", user.id)
          .limit(1)
          .maybeSingle();

        if (workspaceError) {
          console.error("워크스페이스 조회 중 오류 발생:", workspaceError);
          return {
            success: false,
            message: "워크스페이스 조회 중 오류가 발생했습니다.",
          };
        }

        if (workspace)
          return {
            success: true,
            message: "Default Workspace가 설정되어 있지 않습니다.",
            data: workspace,
          };

        return {
          success: false,
          message: "해당 유저의 워크스페이스가 존재하지 않습니다",
        };
      } catch (error) {
        console.error("Default Workspace 조회 중 오류 발생:", error);
        return {
          success: false,
          message: "Default Workspace 조회 중 오류가 발생했습니다.",
        };
      }
    },
    {
      body: t.Object({
        accessToken: t.String({
          description: "Access Token",
          error: "Access token is required",
        }),
      }),
      detail: {
        tags: ["Default Workspace"],
        description: "사용자의 Default Workspace를 조회합니다.",
      },
    },
  );
};
