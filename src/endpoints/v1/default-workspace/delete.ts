import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1DefaultWorkspaceDelete = async (
  app: Elysia<"/v1/default-workspace">,
) => {
  app.post(
    "/delete",
    async (request) => {
      const user = await getUser(request);

      if (!user) {
        return {
          success: false,
          message: "로그인한 이용자만 사용가능합니다.",
        };
      }

      try {
        console.log(user.id);
        const { error } = await supabaseClient
          .from("llami_default_workspace")
          .update({
            updated_at: new Date().toISOString(),
            workspace_id: null,
          })
          .eq("user_id", user.id)
          .maybeSingle();

        if (error) throw error;

        return {
          success: true,
          message: "Default Workspace가 성공적으로 삭제되었습니다.",
        };
      } catch (error) {
        console.error("Default Workspace 삭제 중 오류 발생:", error);
        return {
          success: false,
          message: "Default Workspace 삭제 중 오류가 발생했습니다.",
        };
      }
    },
    {
      body: t.Object({
        accessToken: t.String({
          description: "Access token",
          error: "Access token is required",
          minLength: 100,
        }),
      }),

      detail: {
        tags: ["Default Workspace"],
        description: "사용자의 Default Workspace 지정을 해제합니다.",
      },
    },
  );
};
