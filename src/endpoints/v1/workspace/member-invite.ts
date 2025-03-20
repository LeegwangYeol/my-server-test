import { sendSms } from "@/lib/sms/solapi";
import { supabaseClient } from "@/lib/supabase/client";
import { writeWorkspaceLog } from "@/src/utils/log/discord-logger";
import { normalizePhoneNumber } from "@/src/utils/normalize-phone-number";
import { parsePhoneNumber } from "@/src/utils/parse-phone-number";
import { getUser } from "@/src/utils/get-user-from-token";
import { validatePhoneNumber } from "@/src/utils/validate-phone-number";
import { Elysia, t } from "elysia";

export const v1WorkspaceMemberInvite = async (app: Elysia<"/v1/workspace">) => {
  app.post(
    "/member/invite",
    async ({ body, cookie, request }) => {
      const { workspaceId, phoneNumber: _phoneNumber } = body;
      if (!validatePhoneNumber(_phoneNumber))
        throw new Error("전화번호 형식이 잘못되었습니다.");

      const phoneNumber = normalizePhoneNumber(parsePhoneNumber(_phoneNumber));

      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 조직 정보 확인
      const { data: workspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", workspaceId)
        .limit(1)
        .maybeSingle();

      // * 조직 예외처리
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
            message: "삭제된 조직입니다.",
          };
        }
      }

      // * 조직 소유자인지 확인
      if (workspace.owner !== user.id) {
        // * 소유자가 아니면: 조직에서 멤버에 의한 초대가 허용되어있는지 확인
        if (workspace.only_owner_can_add_members) {
          // * 허용되어있지 않다면: "소유자만 초대할 수 있습니다." 반환
          return {
            success: false,
            message: "소유자만 초대할 수 있습니다.",
          };
        } else {
          // * 허용되어있다면: 해당 조직의 멤버인지 확인
          const { data: member } = await supabaseClient
            .from("llami_workspace_member")
            .select("*")
            .eq("workspace_id", workspaceId)
            .eq("user_id", user.id)
            .eq("is_deleted", false)
            .limit(1)
            .maybeSingle();

          // * 멤버가 아니라면: "조직 멤버만 초대할 수 있습니다." 반환
          if (!member) {
            return {
              success: false,
              message: "조직 소유자 또는 멤버만 초대할 수 있습니다.",
            };
          }
        }
      }

      // * 초대한 멤버가 user 테이블에 존재하는지 확인
      let { data: invitedUser } = await supabaseClient
        .from("user")
        .select("*")
        .eq("phone_number", phoneNumber)
        .limit(1)
        .maybeSingle();

      // * 존재하지 않는 멤버라면: user 테이블에 일단 추가
      if (!invitedUser) {
        // * 유저 추가
        const response = await supabaseClient
          .from("user")
          .insert({ phone_number: phoneNumber })
          .select("*")
          .limit(1)
          .maybeSingle();

        if (response.error) {
          console.error(response.error);
          return {
            success: false,
            message:
              "멤버 초대 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
          };
        }

        if (!response.data) {
          return {
            success: false,
            message:
              "멤버 초대 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
          };
        }

        invitedUser = response.data;
      }

      // * 초대된 멤버가 소유자인지 확인
      if (workspace.owner === invitedUser.id) {
        return {
          success: false,
          message: "조직 소유자는 이미 조직에 속해있습니다.",
        };
      }

      // * 초대한 멤버가 이전에 초대된 멤버인지 확인
      const { data: existingMember } = await supabaseClient
        .from("llami_workspace_member")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("user_id", invitedUser.id)
        .eq("is_deleted", false)
        .limit(1)
        .maybeSingle();

      if (existingMember) {
        return {
          success: false,
          message: "이미 워크스페이스의 멤버입니다.",
        };
      }

      // * 기존 초대 기록 확인
      const { data: existingInvite } = await supabaseClient
        .from("llami_workspace_member_invite")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("invited_user_id", invitedUser.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingInvite) {
        if (existingInvite.is_pending) {
          // 대기 중인 초대인 경우, 메시지만 다시 전송
          await sendSms({
            phoneNumber,
            text: `(LLAMI) ${user.phone_number} 님의 그룹 초대! 아래 링크로 가입하세요.\nhttps://llami.net/invite/${existingInvite.id}`,
          });

          writeWorkspaceLog(
            {
              code: "INVITE_RESEND",
              message: `🔄 조직원 초대 메시지가 재전송되었습니다.\n> **${user.phone_number}**님의 그룹 초대가 **${invitedUser.phone_number}**님에게 재전송되었습니다.`,
              issued_user_id: user.id,
              workspace_id: workspaceId,
            },
            request,
          );

          return {
            success: true,
            message: "대기 중인 초대에 대해 메시지를 다시 전송했습니다.",
          };
        }
      }

      // 초대가 없거나 거절된 경우, 새로운 초대 생성
      const { data: inviteData, error: inviteError } = await supabaseClient
        .from("llami_workspace_member_invite")
        .insert({
          workspace_id: workspaceId,
          invited_user_id: invitedUser.id,
          issued_user_id: user.id,
          is_pending: true,
          is_rejected: false,
        })
        .select("*")
        .limit(1)
        .maybeSingle();

      if (inviteError || !inviteData) {
        console.error(inviteError);
        return {
          success: false,
          message:
            "멤버 초대 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
        };
      }

      // * 해당 멤버에게 SMS 전송
      await sendSms({
        phoneNumber,
        text: `(LLAMI) ${user.phone_number} 님의 그룹 초대! 아래 링크로 가입하세요.\nhttps://llami.net/invite/${inviteData.id}`,
      });

      writeWorkspaceLog(
        {
          code: "INVITE",
          message: `🎉 조직원 신규 초대가 발생하였습니다.\n> **${user.phone_number}**님의 조직 초대가 **${invitedUser.phone_number}**님에게 전송되었습니다.`,
          issued_user_id: user.id,
          workspace_id: workspaceId,
        },
        request,
      );

      return {
        success: true,
        message: "초대 메세지가 전달 되었습니다.",
      };
    },
    {
      detail: {
        tags: ["Workspace Member"],
        description: "Invite a member to the workspace.",
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
        phoneNumber: t.String({
          description: "Phone Number",
          error: "Phone Number is required",
          minLength: 0,
          maxLength: 20,
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
