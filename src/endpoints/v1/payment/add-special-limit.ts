import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";
import { writeWorkspaceLog } from "@/src/utils/log/discord-logger";

export const v1PaymentAddSpecialLimit = async (app: Elysia<"/v1/payment">) => {
  app.post(
    "/special/add",
    async ({ body, cookie, request }) => {
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능해요.",
        };
      }
      const workspaceId = body.workspaceId;
      const couponNumber = "356Q48P";

      if (body.coupon !== couponNumber) {
        return {
          success: false,
          message: "쿠폰 번호가 다른거 같아요. 다시 확인해주세요.",
        };
      }

      const { data } = await supabaseClient
        .from("llami_workspace_log")
        .select("id")
        .eq("issued_user_id", user.id)
        .eq("code", couponNumber);

      if (data != null && data.length > 0) {
        return {
          success: false,
          message: "이미 쿠폰을 사용했어요.",
        };
      }

      const { data: workspaceLimit } = await supabaseClient
        .from("llami_workspace_usage_limit")
        .select("*")
        .eq("workspace_id", workspaceId)
        .limit(1)
        .maybeSingle();

      const remainCount = workspaceLimit?.special_usage_count ?? 0;
      const { error } = await supabaseClient
        .from("llami_workspace_usage_limit")
        .upsert({
          workspace_id: workspaceId,
          special_usage_count: remainCount + 10000,
        })
        .eq("workspace_id", workspaceId);

      if (error) {
        return {
          success: false,
          message: "쿠폰 충전 중 에러가 발생했어요.",
        };
      }

      // * 위젯 생성 로그 전송
      await writeWorkspaceLog(
        {
          code: "356Q48P",
          message: `🎫 **${user.phone_number}**님이 쿠폰으로 10000회 추가 충전했어요.`,
          issued_user_id: user.id,
          workspace_id: workspaceId,
        },
        request,
      );

      return {
        success: true,
        message: "쿠폰으로 10000회 추가 충전했어요.",
      };
    },
    {
      detail: {
        tags: ["Payment"],
        description: "Deposit workspace",
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
        coupon: t.String({
          description: "Coupon",
          error: "Coupon string is required",
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
