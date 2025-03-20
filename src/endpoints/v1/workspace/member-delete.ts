import { supabaseClient } from "@/lib/supabase/client";
import { writeWorkspaceLog } from "@/src/utils/log/discord-logger";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";
export const v1WorkspaceMemberDelete = async (app: Elysia<"/v1/workspace">) => {
  app.post(
    "/member/delete",
    async ({ body, cookie, request }) => {
      const { workspaceId, userId } = body;
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
        .eq("is_deleted", false)
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
        if (
          workspace.only_owner_can_add_members &&
          workspace.owner !== user.id
        ) {
          return {
            success: false,
            message: "조직 소유자만 멤버를 삭제할 수 있습니다.",
          };
        }
      }

      // * 멤버가 현재 속해있는지 확인 (llami_workspace_member 테이블)
      const { data: member } = await supabaseClient
        .from("llami_workspace_member")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .eq("is_deleted", false)
        .limit(1)
        .maybeSingle();

      if (member) {
        // * 멤버 삭제
        const response = await supabaseClient
          .from("llami_workspace_member")
          .update({
            is_deleted: true,
          })
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId);

        if (response.error) {
          console.log(response.error);
          return {
            success: false,
            message:
              "네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
          };
        }

        // * 멤버 삭제 로그 전송
        (async () => {
          const memberUserData = await supabaseClient
            .from("user")
            .select("*")
            .eq("id", member.user_id)
            .limit(1)
            .maybeSingle();

          if (memberUserData && memberUserData.data) {
            writeWorkspaceLog(
              {
                code: "MEMBER_DELETE",
                issued_user_id: user.id,
                message: `🚪 **${workspace.name ?? "개인계정"}** 조직에서 멤버 삭제가 발생했습니다.\n> **${
                  user.phone_number
                }**님이 **${memberUserData.data.phone_number}**님을 삭제하였습니다.`,
                workspace_id: workspaceId,
              },
              request,
            );
          }
        })();
      } else {
        // * 멤버가 없으면 초대 대기 중인 멤버인지 확인 (llami_workspace_member_invite 테이블)
        const { data: invite } = await supabaseClient
          .from("llami_workspace_member_invite")
          .select("*")
          .eq("workspace_id", workspaceId)
          .eq("invited_user_id", userId)
          .eq("is_deleted", false)
          .limit(1)
          .maybeSingle();

        if (invite) {
          // * 초대 취소 (삭제)
          const response = await supabaseClient
            .from("llami_workspace_member_invite")
            .update({
              is_deleted: true,
            })
            .eq("workspace_id", workspaceId)
            .eq("invited_user_id", userId);

          if (response.error) {
            console.log(response.error);
            return {
              success: false,
              message:
                "맴버 삭제에 실패하였습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
            };
          }

          // * 초대 취소 로그 전송
          (async () => {
            const invitedUserData = await supabaseClient
              .from("user")
              .select("*")
              .eq("id", invite.invited_user_id!)
              .limit(1)
              .maybeSingle();

            if (invitedUserData && invitedUserData.data) {
              writeWorkspaceLog(
                {
                  code: "INVITE_CANCEL",
                  issued_user_id: user.id,
                  message: `❌ 조직 인원 초대 취소가 발생하였습니다.\n> **${user.phone_number}**님이 **${invitedUserData.data.phone_number}**님에게 보낸 초대를 취소하였습니다.`,
                  workspace_id: workspaceId,
                },
                request,
              );
            }
          })();
        } else {
          // * 멤버가 아니고, 초대 대기 중인 멤버도 아님
          return {
            success: true,
            // ! 보안 상의 이유로 실패 메시지를 반환하지 않습니다.
          };
        }
      }

      return {
        success: true,
      };
    },
    {
      detail: {
        tags: ["Workspace Member"],
        description:
          "Delete a member or cancel an invitation from the workspace.",
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
          minLength: 1,
          maxLength: 100,
        }),
        userId: t.String({
          description: "User ID",
          error: "User ID is required",
          minLength: 1,
          maxLength: 100,
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
