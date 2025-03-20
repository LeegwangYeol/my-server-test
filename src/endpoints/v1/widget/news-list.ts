import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";

export const v1NewsList = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/news/list",
    async ({ body, cookie }) => {
      // * 유저 정보 확인
      const user = await getUser({ body, cookie });

      if (!user) {
        throw new Error("로그인 한 이용자만 사용가능합니다.");
      }

      const { data } = await supabaseClient
        .from("llami_news")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      return {
        success: true,
        data,
      };
    },
    {
      detail: {
        tags: ["Widget News"],
        description: "Widget News List",
      },
    },
  );
};
