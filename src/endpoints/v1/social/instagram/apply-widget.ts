import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1SocialInstagramApplyWidget = async (
  app: Elysia<"/v1/social">,
) => {
  app.post(
    "/instagram/apply-widget",
    async ({ body, cookie }) => {
      const { widgetId, instagramId } = body;
      // const user = await getUser({ body, cookie });
      // if (!user) {
      //   return {
      //     success: false,
      //     message: "로그인 한 이용자만 사용가능합니다.",
      //   };
      // }

      // // * 위젯 정보 확인
      const { data: widget } = await supabaseClient
        .from("llami_widget")
        .select("*")
        .eq("id", widgetId)
        .limit(1)
        .maybeSingle();

      // * 위젯 예외처리
      {
        if (!widget) {
          return {
            success: false,
            message: "존재하지 않는 위젯입니다.",
          };
        }
      }

      // // * 워크스페이스 정보 확인
      // const { data: workspace } = await supabaseClient
      //   .from("llami_workspace")
      //   .select("*")
      //   .eq("id", widget.workspace_id)
      //   .limit(1)
      //   .maybeSingle();

      // // * 워크스페이스 예외처리
      // {
      //   if (!workspace) {
      //     return {
      //       success: false,
      //       message: "존재하지 않는 조직입니다.",
      //     };
      //   }
      //   if (workspace.is_deleted) {
      //     return {
      //       success: false,
      //       message: "삭제된 조직입니다.",
      //     };
      //   }
      // }

      // // * 소유주인지 또는 멤버인지 확인
      // const { data: member } = await supabaseClient
      //   .from("llami_workspace_member")
      //   .select("*")
      //   .eq("workspace_id", workspace.id)
      //   .eq("user_id", user.id)
      //   .eq("is_deleted", false)
      //   .limit(1)
      //   .maybeSingle();

      // // * 멤버 예외처리
      // if (workspace.owner !== user.id && !member) {
      //   return {
      //     success: false,
      //     message: "해당 조직의 소유주나 멤버가 아닙니다.",
      //   };
      // }

      // * 위젯 ID 갱신
      const { data, error } = await supabaseClient
        .from("llami_chat_oauth_token")
        .update({
          widget_id: widgetId,
        })
        .eq("business_type", "instagram")
        .eq("business_id", instagramId)
        .eq("is_deleted", false)
        .select("*")
        .maybeSingle();

      // * 예외처리
      {
        if (error) {
          console.error(
            `인스타그램 위젯 갱신에 실패했습니다. (INSTAGRAM ID: ${instagramId}, WIDGET ID ${
              widgetId
            })`,
          );
          // * 에러 메세지 표시
          console.log("수파베이스 에러:", error);

          return {
            success: false,
            message: "인스타그램 위젯 갱신에 실패했습니다.",
          };
        }
      }

      return {
        success: true,
        message: "위젯이 성공적으로 적용되었습니다.",
      };
    },
    {
      detail: {
        tags: ["Social"],
        description: "Apply Instagram Widget",
      },
      body: t.Object({
        widgetId: t.String({
          description: "Widget ID",
          error: "Widget ID is required",
        }),
        instagramId: t.String({
          description: "Instagram ID",
          error: "Instagram ID is required",
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
