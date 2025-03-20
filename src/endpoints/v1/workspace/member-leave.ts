import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WorkspaceMemberLeave = async (app: Elysia<"/v1/workspace">) => {
  app.post(
    "/member/leave",
    async ({ body, cookie }) => {
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
        if (workspace.owner === user.id) {
          return {
            success: false,
            message:
              "조직 소유자는 조직을 떠날 수 없습니다. 대신 조직 소유자 권한을 다른 멤버에게 승계하거나, 조직 삭제를 진행할 수 있습니다.",
          };
        }
      }

      // * 멤버 확인
      const { data: member } = await supabaseClient
        .from("llami_workspace_member")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("user_id", user.id)
        .eq("is_deleted", false)
        .limit(1)
        .maybeSingle();

      // * 멤버 예외처리
      if (!member) {
        return {
          success: false,
          message: "현재 조직에 속해있지 않아서 떠날 수 없습니다.",
        };
      }

      // * 멤버 삭제 (소프트 딜리트)
      const response = await supabaseClient
        .from("llami_workspace_member")
        .update({
          is_deleted: true,
        })
        .eq("id", member.id);

      // * 멤버 삭제 예외처리
      if (response.error) {
        console.error(response.error);
        return {
          success: false,
          message: response.error.message,
        };
      }

      return {
        success: true,
        message: "해당 조직을 성공적으로 떠났습니다.",
      };
    },
    {
      detail: {
        tags: ["Workspace Member"],
        description: "Leave the workspace.",
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
