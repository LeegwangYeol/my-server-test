import { Elysia, redirect, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";

interface InstagramMeData {
  id: string;
  user_id: string;
  username: string;
  account_type: "BUSINESS" | "MEDIA_CREATOR";
}
export const v1SocialInstagramOAuth = async (app: Elysia<"/v1/social">) => {
  app.get(
    "/instagram/oauth",
    async ({ query }) => {
      // * 인스타그램 OAuth 코드
      const code = query.code;

      if (!code) {
        console.error("인스타그램 OAuth 코드가 없습니다.");
        return {
          success: false,
          error: "No code provided",
        };
      }

      // @reference https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
      // * Exchange the Code For a Token
      const scope =
        "instagram_basic,instagram_manage_messages,instagram_business_manage_messages,instagram_graph_user_profile,instagram_graph_user_media,instagram_business_content_publish,instagram_business_manage_comments";
      const response = await fetch(
        "https://api.instagram.com/oauth/access_token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: process.env.INSTAGRAM_CLIENT_ID!,
            client_secret: process.env.INSTAGRAM_CLIENT_SECRET!,
            grant_type: "authorization_code",
            redirect_uri: process.env.INSTAGRAM_REDIRECT_URI!,
            code,
            scope: scope,
            response_type: "code",
          }),
        },
      );

      // * 인스타그램 API로부터 받은 응답
      const responseText = await response.text();

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (error) {
        console.error("JSON 파싱 에러:", error);
        console.error("받은 응답:", responseText);
        return {
          success: false,
          error: "Failed to parse Instagram response",
        };
      }

      const { access_token } = data;
      // * 롱 라이브 토큰 받기
      const { access_token: longLiveToken } = await (
        await fetch(
          `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${process.env.INSTAGRAM_CLIENT_SECRET}&access_token=${access_token}`,
        )
      ).json();

      // * 비즈니스 계정 ID 받기
      const businessAccountResponse = await fetch(
        `https://graph.instagram.com/v21.0/me?fields=id,user_id,username,account_type&access_token=${longLiveToken}`,
      );

      const businessAccountResponseData =
        (await businessAccountResponse.json()) as
          | InstagramMeData[]
          | InstagramMeData;

      // * 배열인경우 비즈니스 계정인것만 필터링 한 후 중 0번째를 가져오기, 배열아니면 그대로 사용
      const businessAccount = Array.isArray(businessAccountResponseData)
        ? businessAccountResponseData.filter(
            (data) => data.account_type === "BUSINESS",
          )[0]
        : businessAccountResponseData;

      // 예외처리
      if (!businessAccount) {
        console.error("비즈니스 계정이 아닙니다.");
        return {
          success: false,
          error: "Not a business account",
        };
      }

      // * 수파베이스 디비에 저장하기 (롱라이브 토큰은 60일만 유효함, 나중에 리프래시 가능)
      const { error, statusText } = await supabaseClient
        .from("llami_chat_oauth_token")
        .upsert({
          business_id: businessAccount.user_id,
          business_type: "instagram",
          token: longLiveToken,
        });

      if (error) {
        console.error(
          "인스타그램 정보를 Supabase에 저장하는데 실패했습니다.",
          statusText,
          error,
        );
      }

      // * 인스타그램 웹훅 구독 API 호출
      // * @reference https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/webhooks#subscribe-to-webhooks
      try {
        const subscribeResponse = await fetch(
          `https://graph.instagram.com/v21.0/${businessAccount.user_id}/subscribed_apps?` +
            `subscribed_fields=messages&` +
            `access_token=${longLiveToken}`,
          {
            method: "POST",
          },
        );

        if (!subscribeResponse.ok) {
          console.error(
            "인스타그램 웹훅 구독에 실패했습니다.",
            await subscribeResponse.text(),
          );
        }
      } catch (error) {
        console.error("인스타그램 웹훅 구독 중 에러가 발생했습니다.", error);
      }

      // * https://llami.net/chat 으로 리다이렉트
      return redirect(
        `https://llami.net/oauth/instagram-connect?instagram_id=${businessAccount.user_id}`,
      );
    },
    {
      detail: {
        tags: ["Social"],
        description: "Social OAuth endpoint",
      },
    },
  );
};
