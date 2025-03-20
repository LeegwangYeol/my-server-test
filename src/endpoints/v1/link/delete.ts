import { supabaseClient } from "@/lib/supabase/client";
import { Elysia, t } from "elysia";

export const v1DeleteQR = async (app: Elysia<"/v1/link">) => {
  app.post(
    "/delete",
    async ({ body: { widgetId } }) => {
      // * Widget ID가 Supabase 에 존재하지 않을 경우
      const { data: widgetData, error: widgetError } = await supabaseClient
        .from("llami_widget")
        .select("*")
        .eq("id", widgetId)
        .limit(1)
        .maybeSingle();

      // * 에러 처리
      if (widgetError) {
        return {
          success: false,
          message: widgetError.message,
        };
      }

      // * Widget ID가 Supabase 에 존재하지 않을 경우
      if (!widgetData) {
        return {
          success: false,
          message: "Widget ID does not exist",
        };
      }

      // * 기존 AIQR 데이터 조회
      const { data, error } = await supabaseClient
        .from("llami_shortlink_aiqr_io")
        .select("*")
        .eq("widget_id", widgetId)
        .limit(1)
        .maybeSingle();

      if (error) {
        return {
          success: false,
          message: "Error fetching AIQR data",
        };
      }

      if (data) {
        // * 해당 테이블에서 정보 삭제
        const { error: deleteError } = await supabaseClient
          .from("llami_shortlink_aiqr_io")
          .delete()
          .eq("widget_id", widgetId);

        if (deleteError) {
          return {
            success: false,
            message: "Error deleting AIQR data",
          };
        }

        return {
          success: true,
          message: "AIQR data deleted successfully",
        };
      }

      // * 성공
      return {
        success: true,
        message: "Success",
      };
    },
    {
      detail: {
        tags: ["Link"],
        description: "Delete AIQR link",
      },
      body: t.Object({
        widgetId: t.String({
          description: "Widget ID",
          error: "Widget ID is required",
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
