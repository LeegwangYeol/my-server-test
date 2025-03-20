import { supabaseClient } from "@/lib/supabase/client";
import { writeWorkspaceLog } from "@/src/utils/log/discord-logger";
import { Elysia, t } from "elysia";

export const v1WorkspaceMemberInviteAccept = async (
  app: Elysia<"/v1/workspace">,
) => {
  app.post(
    "/member/invite/accept",
    async ({ body, request }) => {
      const { inviteId, approve } = body;

      // * 초대 정보 확인
      const { data: invite } = await supabaseClient
        .from("llami_workspace_member_invite")
        .select("*")
        .eq("id", inviteId)
        .limit(1)
        .maybeSingle();

      // * 초대 예외처리
      {
        if (!invite) {
          return {
            success: false,
            message: "존재하지 않는 초대입니다.",
          };
        }
        if (invite.is_deleted) {
          return {
            success: false,
            message: "취소된 초대입니다.",
          };
        }
        if (!invite.is_pending) {
          return {
            success: false,
            message: "활성화되지 않은 초대입니다.",
          };
        }
        if (!invite.workspace_id) {
          return {
            success: false,
            message: "존재하지 않는 워크스페이스입니다.",
          };
        }
        if (!invite.invited_user_id) {
          return {
            success: false,
            message: "존재하지 않는 유저에 대한 초대입니다.",
          };
        }
      }

      // * 초대정보로 초대된 유저 정보 확인
      const { data: user } = await supabaseClient
        .from("user")
        .select("*")
        .eq("id", invite.invited_user_id)
        .limit(1)
        .maybeSingle();

      // * 유저 예외처리
      if (!user) {
        return {
          success: false,
          message:
            "초대 정보에 해당하는 유저정보가 확인되지 않습니다. 초대를 다시 요청해주세요.",
        };
      }

      // * 초대 수락처리
      if (approve) {
        // * 초대 수락
        const response = await supabaseClient
          .from("llami_workspace_member")
          .insert({
            workspace_id: invite.workspace_id,
            user_id: user.id,
          });

        // * 초대 수락 예외처리
        {
          if (response.error) {
            console.error(response.error);
            return {
              success: false,
              message:
                "네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
            };
          }
        }

        // * 초대 정보 갱신
        await supabaseClient
          .from("llami_workspace_member_invite")
          .update({
            is_pending: false,
            is_rejected: false,
          })
          .match({ id: inviteId });
      } else {
        // * 초대 정보 갱신
        await supabaseClient
          .from("llami_workspace_member_invite")
          .update({
            is_pending: false,
            is_rejected: true,
          })
          .match({ id: inviteId });
      }

      try {
        // * 초대받은 사람 유저 정보 조회
        const { data: invitedUser } = await supabaseClient
          .from("user")
          .select("*")
          .eq("id", invite.invited_user_id!)
          .limit(1)
          .maybeSingle();

        writeWorkspaceLog(
          {
            code: approve ? "INVITE_APPROVE" : "INVITE_REJECT",
            message: `🎉 **${invitedUser?.phone_number}**님이 **${user.phone_number}** 님의 워크스페이스 초대를 **${
              approve ? "수락" : "거절"
            }**하였습니다.`,
            issued_user_id: user.id,
            workspace_id: invite.workspace_id,
          },
          request,
        );
      } catch (e) {
        console.error(e);
      }

      return {
        success: true,
        message: "성공적으로 처리되었습니다.",
      };
    },
    {
      detail: {
        tags: ["Workspace Member"],
        description: "Accept or reject a workspace member invitation.",
      },
      body: t.Object({
        inviteId: t.String({
          description: "Invite ID",
          error: "Invite ID is required",
        }),
        approve: t.Boolean({
          description: "Approve",
          error: "Approve is required",
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
