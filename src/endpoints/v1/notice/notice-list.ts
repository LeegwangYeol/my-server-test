import { Elysia } from "elysia";
import { supabaseClient } from "../../../../lib/supabase/client";

export const v1GetNoticeList = async (app: Elysia<"/v1/notice">) => {
  app.post(
    "/get/notice/list",
    async ({}) => {
      const { data: NoticeList } = await supabaseClient
        .from("llami_notice")
        .select("*")
        .order("created_at", { ascending: false });
      return {
        success: true,
        data: NoticeList,
      };
    },
    {
      detail: {
        tags: ["Notice"],
        description: "get notice list",
      },
    },
  );
};
