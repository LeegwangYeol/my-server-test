import { supabaseClient } from "@/lib/supabase/client";
import { writeWorkspaceLog } from "@/src/utils/log/discord-logger";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WorkspaceSuccession = async (app: Elysia<"/v1/workspace">) => {
  app.post(
    "/succession",
    async ({ body, cookie, request }) => {
      const { workspaceId, successorUserId, accessToken } = body;

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
      }

      // * 승계자 확인
      const { data: successor } = await supabaseClient
        .from("llami_workspace_member")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("user_id", successorUserId)
        .eq("is_deleted", false)
        .limit(1)
        .maybeSingle();

      // * 승계자 예외처리
      {
        if (!successor) {
          return {
            success: false,
            message: "존재하지 않는 승계자입니다.",
          };
        }
        if (successor.user_id === user.id) {
          return {
            success: false,
            message: "자신을 승계자로 지정할 수 없습니다.",
          };
        }
      }

      // * 소유자 변경
      const response = await supabaseClient
        .from("llami_workspace")
        .update({ owner: successorUserId })
        .eq("id", workspaceId);

      // * 소유자 변경 예외처리
      if (response.error) {
        return {
          success: false,
          message: response.error.message,
        };
      }

      (async () => {
        const actualSuccessorData = await supabaseClient
          .from("user")
          .select("phone_number")
          .eq("id", successorUserId)
          .limit(1)
          .maybeSingle();

        if (actualSuccessorData && actualSuccessorData.data) {
          writeWorkspaceLog(
            {
              code: "WORKSPACE_OWNER_CHANGE",
              issued_user_id: user.id,
              workspace_id: workspaceId,
              message: `👀 조직 소유자 승계가 발생하였습니다.\n**${
                workspace.name ?? "개인계정"
              }** 조직 소유자가 변경되었습니다. (이전 소유자: **${user.phone_number}**, 신규 소유자: **${
                actualSuccessorData.data.phone_number
              }**)`,
            },
            request,
          );
        }
      })();

      return {
        success: true,
        message: "조직 소유자가 성공적으로 변경되었습니다.",
      };
    },
    {
      detail: {
        tags: ["Workspace"],
        description:
          "Transfer ownership of the organization to another member.",
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
        successorUserId: t.String({
          description: "Successor User ID",
          error: "Successor User ID is required",
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
