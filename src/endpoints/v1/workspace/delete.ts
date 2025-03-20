import { supabaseClient } from "@/lib/supabase/client";
import { writeWorkspaceLog } from "@/src/utils/log/discord-logger";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WorkspaceDelete = async (app: Elysia<"/v1/workspace">) => {
  app.post(
    "/delete",
    async ({ body, cookie, request }) => {
      const { workspaceId } = body;
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 워크스페이스 정보 확인
      const { data: workspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", workspaceId)
        .limit(1)
        .maybeSingle();

      // * 워크스페이스 예외처리
      {
        if (!workspace) {
          return {
            success: false,
            message: "존재하지 않는 조직입니다.",
          };
        }
        if (workspace.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 조직입니다.",
          };
        }
        if (workspace.owner !== user.id) {
          return {
            success: false,
            message: "조직 소유자만이 조직을 삭제할 수 있습니다.",
          };
        }
      }

      const { error: workspaceError } = await supabaseClient
        .from("llami_workspace")
        .update({ is_deleted: true })
        .eq("id", workspaceId);

      if (workspaceError) {
        console.error("Workspace update error:", workspaceError);
        return {
          success: false,
          message: "워크스페이스 삭제 중 오류가 발생했습니다.",
        };
      }

      const { error: memberError } = await supabaseClient
        .from("llami_workspace_member")
        .update({ is_deleted: true })
        .eq("workspace_id", workspaceId);

      if (memberError) {
        console.error("Workspace member update error:", memberError);
        // 여기서는 에러를 반환하지 않고 계속 진행합니다.
      }

      const { error: inviteError } = await supabaseClient
        .from("llami_workspace_member_invite")
        .update({ is_deleted: true })
        .eq("workspace_id", workspaceId);

      if (inviteError) {
        console.error("Workspace member invite update error:", inviteError);
        // 여기서는 에러를 반환하지 않고 계속 진행합니다.
      }

      writeWorkspaceLog(
        {
          code: "DELETE_WORKSPACE",
          issued_user_id: user.id,
          message: `🗑 **${user.phone_number}**님의 **${workspace.name ?? "개인계정"}** 조직이 삭제되었습니다.`,
          workspace_id: workspace.id,
        },
        request,
      );

      return {
        success: true,
        message: "해당 조직이 성공적으로 삭제되었습니다.",
      };
    },
    {
      detail: {
        tags: ["Workspace"],
        description: "Delete Workspace",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        workspaceId: t.String({
          description: "Workspace ID",
          error: "Workspace ID is required",
        }),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "Success",
          error: "Success is required",
        }),
        message: t.Optional(
          t.String({
            description: "Message",
            error: "Message is required",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
      }),
    },
  );
};
