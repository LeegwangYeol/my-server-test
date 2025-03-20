import { supabaseClient } from "@/lib/supabase/client";
import { Elysia, t } from "elysia";
import { encode } from "pseudo-shuffle";

const shuffleConfig = {
  min: 0,
  max: 36 ** 6 - 1,
  privateKey: process.env.SHUFFLE_PRIVATE_KEY!,
};

export const v1LinkAIQR = async (app: Elysia<"/v1/link">) => {
  app.post(
    "/aiqr",
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

      // * 에러 처리
      if (error) {
        console.log("기존 AIQR 데이터 조회실패", error);
        return {
          success: false,
          message: error.message,
        };
      }

      // * 데이터가 있을 경우
      if (data) {
        return {
          success: true,
          message: "Success",
          link: `https://${encode({
            index: data.id,
            ...shuffleConfig,
          }).toString(36)}.aiqr.io`,
        };
      }

      // * 데이터가 없을 경우, 값을 추가
      const { data: newData, error: newDataError } = await supabaseClient
        .from("llami_shortlink_aiqr_io")
        .insert({
          widget_id: widgetId,
        })
        .select("*")
        .limit(1)
        .maybeSingle();

      // * 에러 처리
      if (newDataError) {
        console.log("신규 AIQR 데이터 생성실패", newDataError);
        return {
          success: false,
          message: newDataError.message,
        };
      }

      // * 데이터가 없을 경우
      if (!newData) {
        return {
          success: false,
          message: "Failed to create a new AIQR link",
        };
      }

      // * 성공
      return {
        success: true,
        message: "Success",
        link: `https://${encode({
          index: newData.id,
          ...shuffleConfig,
        }).toString(36)}.aiqr.io`,
      };
    },
    {
      detail: {
        tags: ["Link"],
        description: "Get AIQR link",
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
        link: t.Optional(
          t.String({
            description: "Link",
            error: "Link is required",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
      }),
    },
  );
};
