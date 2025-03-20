import { supabaseClient } from "@/lib/supabase/client";
import { Elysia, t } from "elysia";

export const v1WorkspaceMemberInviteView = async (
  app: Elysia<"/v1/workspace">,
) => {
  app.post(
    "/member/invite/view",
    async ({ body: { inviteId } }) => {
      // * 초대 정보 확인
      const { data: invite } = await supabaseClient
        .from("llami_workspace_member_invite")
        .select("*")
        .eq("id", inviteId)
        .limit(1)
        .maybeSingle();

      // * 초대 정보 예외처리
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
            message: "이미 삭제된 초대입니다.",
          };
        }
        if (invite.is_pending) {
          return {
            success: false,
            message: "활성화되지 않은 초대입니다.",
          };
        }
      }

      return {
        success: true,
        message: "초대 정보 조회 성공",
        detail: invite,
      };
    },
    {
      detail: {
        tags: ["Workspace Member"],
        description: "Workspace member invite view",
      },
      body: t.Object({
        inviteId: t.String({
          description: "Invite ID",
          error: "Invite ID is required",
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
        detail: t.Optional(t.Any({})),
      }),
    },
  );
};
