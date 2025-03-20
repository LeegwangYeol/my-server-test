import { checkPrimaryApiKey } from "@/lib/api-key";
import { sendSms } from "@/lib/sms/solapi";
import { supabaseClient } from "@/lib/supabase/client";
import { writeWorkspaceLog } from "@/src/utils/log/discord-logger";
import { Elysia, t } from "elysia";

export const v1WorkspaceLimitUse = async (app: Elysia<"/v1/workspace">) => {
  app.post(
    "/limit/use",
    async ({
      body: {
        workspaceId,
        apiKey,
        usedCount,
        questionTokenCount,
        answerTokenCount,
      },
      request,
    }) => {
      if (!(await checkPrimaryApiKey(apiKey))) {
        throw new Error("Invalid API key");
      }

      // * 워크스페이스 정보 확인
      const { data: workspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", workspaceId)
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

      // * 워크스페이스 사용 제한 확인
      const { data: workspaceLimit } = await supabaseClient
        .from("llami_workspace_usage_limit")
        .select("*")
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      // * 워크스페이스 사용 제한 예외처리
      if (!workspaceLimit) {
        console.error(`Workspace Limit not found: ${workspaceId}`);
        return {
          success: false,
          message:
            "사용할 수 없는 조직입니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
        };
      }

      // * 현재 계산된 refresh_usage_count
      let currentRefreshTokenCount: number =
        workspaceLimit.refresh_usage_count ?? 0;

      // * refresh_usage_count 은 updated_at 이 1달 이상 지났을 경우 100으로 초기화합니다.
      let isRefreshNeeded = false;

      // ! LLAMI 팀에서 매월 신규 결정된 사용량으로 초기화를 결정한 경우에만 활성화해야합니다.
      let isLLAMITeamDecidedMonthlyRefresh = false;

      if (isLLAMITeamDecidedMonthlyRefresh && workspaceLimit.updated_at) {
        const updatedAt = new Date(workspaceLimit.updated_at);
        const now = new Date();
        const diff = now.getTime() - updatedAt.getTime();
        const diffDays = diff / (1000 * 60 * 60 * 24);
        if (diffDays >= 30) {
          isRefreshNeeded = true;
          currentRefreshTokenCount = 20;
        }
      }

      // * 남은 사용량 계산
      const totalRemainCount =
        currentRefreshTokenCount + (workspaceLimit.special_usage_count ?? 0);

      // * 남은 사용량이 일정량 이하로 떨어지면 워크스페이스 소유주에게 SMS 발송 로직
      if (
        !workspaceLimit.has_usage_alert_sent &&
        workspace.owner &&
        totalRemainCount <= (workspaceLimit.usage_alert_count ?? 4)
      ) {
        try {
          // * 소유주 정보 가져오기
          const { data: owner } = await supabaseClient
            .from("user")
            .select("phone_number")
            .eq("id", workspace.owner)
            .maybeSingle();

          if (owner && owner.phone_number) {
            const message = `(LLAMI) A.I 상담 잔여 대화량이 ${
              workspaceLimit.usage_alert_count ?? 4
            }개 이하로 남았습니다. 추가 구매를 고려해 주세요. https://llami.net/widget/payment`;
            await sendSms({
              phoneNumber: owner.phone_number,
              text: message,
            });
            writeWorkspaceLog(
              {
                code: "USAGE_ALERT_SENT",
                issued_user_id: workspace.owner,
                workspace_id: workspace.id,
                message: `💳 **${workspace.name ?? "개인계정"}** 조직에 남은 A.I 제한량이
**${workspaceLimit.usage_alert_count ?? 4}개** 이하로 남아서 알림 문자가 발송되었습니다.\n> **${
                  owner.phone_number
                }**님이 해당 조직의 소유자입니다.`,
              },
              request,
            );
          }
        } catch (e) {
          console.error("Failed to send SMS to owner", e);
        }
      }

      // * 먼저 refresh_usage_count 이 usedtoken 보다 작은게 아니면 refresh_usage_count 이 소모되어야합니다.
      if (currentRefreshTokenCount >= usedCount) {
        let recalculatedRefreshTokenCount =
          currentRefreshTokenCount - usedCount;

        if (recalculatedRefreshTokenCount < 0)
          recalculatedRefreshTokenCount = 0;

        const { error } = await supabaseClient
          .from("llami_workspace_usage_limit")
          .update({
            refresh_usage_count: recalculatedRefreshTokenCount,
            refreshed_at: isRefreshNeeded
              ? new Date().toISOString()
              : undefined,
            updated_at: new Date().toISOString(),
          })
          .match({ workspace_id: workspaceId });

        // * 예외처리
        if (error) {
          console.error("Failed to update workspace limit", error);
          return {
            success: false,
            message: "Failed to update workspace limit",
          };
        }

        // * 로그 기록
        await supabaseClient.from("llami_workspace_usage_log").insert({
          workspace_id: workspaceId,
          question_token_count: questionTokenCount ?? 0,
          answer_token_count: answerTokenCount ?? 0,
        });

        return {
          success: true,
          message: "Success",
        };
      } else {
        // * refresh_usage_count 가 부족하다면 special_usage_count 이 소모되어야 합니다.
        // * isRefreshNeeded 가 true 일 경우 refresh_usage_count 를 100으로 초기화합니다.
        const currentSpecialTokenCount =
          workspaceLimit.special_usage_count ?? 0;
        if (currentSpecialTokenCount >= usedCount) {
          await supabaseClient
            .from("llami_workspace_usage_limit")
            .update({
              special_usage_count: currentSpecialTokenCount - usedCount,
            })
            .match({ workspace_id: workspaceId });

          // * 로그 기록
          await supabaseClient.from("llami_workspace_usage_log").insert({
            workspace_id: workspaceId,
            question_token_count: questionTokenCount ?? 0,
            answer_token_count: answerTokenCount ?? 0,
          });

          return {
            success: true,
            message: "Success",
          };
        } else {
          return {
            success: false,
            message: "A.I 잔여 대화량이 부족합니다.",
          };
        }
      }
    },
    {
      detail: {
        tags: ["Workspace Limit"],
        description: "",
      },
      body: t.Object({
        apiKey: t.String({
          description: "LLAMI SaaS API key",
          error: "API key is required",
          minLength: 1,
          maxLength: 100,
        }),
        workspaceId: t.String({
          description: "Workspace ID",
          error: "Widget ID is required",
        }),
        usedCount: t.Number({
          description: "Used Count",
          error: "Used Count is required",
          minimum: 1,
        }),
        questionTokenCount: t.Optional(
          t.Number({
            description: "Question Token Count",
            error: "Question Token Count is required",
            minimum: 0,
          }),
        ),
        answerTokenCount: t.Optional(
          t.Number({
            description: "Answer Token Count",
            error: "Answer Token Count is required",
            minimum: 0,
          }),
        ),
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
