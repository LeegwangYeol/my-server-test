import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";

export const v1AccountGetUserProfile = async (app: Elysia<"/v1/account">) => {
  app.post(
    "/get/user/profile",
    async ({ body, cookie }) => {
      // * 유저 정보 확인
      const user = await getUser({ body, cookie });

      if (!user) {
        throw new Error("로그인 한 이용자만 사용가능합니다.");
      }
      // * 계정정보 가져오기
      const { data } = await supabaseClient
        .from("user_profile")
        .select("*")
        .eq("id", user.id)
        .limit(1)
        .maybeSingle();

      return {
        success: true,
        data,
      };
    },
    {
      detail: {
        tags: ["Account"],
        description: "Account login endpoint",
      },
    },
  );
};
