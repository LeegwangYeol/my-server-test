import { uploadImageFile } from "@/lib/storage/r2Client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";

export const v1UpdateUserProfile = async (app: Elysia<"/v1/account">) => {
  app.post(
    "/update/user/profile",
    async ({ body, cookie }) => {
      const { nickName, profileImage } = body; // 추가된 코드
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 닉네임 업데이트
      await supabaseClient.from("user_profile").upsert({
        id: user.id,
        nick_name: nickName,
      });

      // * 이미지 파일을 ArrayBuffer로 변환
      if (profileImage === undefined)
        return {
          success: false,
          message: "프로필 이미지가 제공되지 않았습니다.",
        };
      const buffer = await profileImage.arrayBuffer();

      // * 이미지 업로드
      try {
        const profileUrl = await uploadImageFile({
          buffer,
          folder: "user-profile-v1",
          compress: false,
        });

        await supabaseClient.from("user_profile").upsert({
          id: user.id,
          profile_url: profileUrl,
        });

        return {
          success: true,
          message: "유저 프로필 정보 업로드 성공",
        };
      } catch (error: any) {
        console.error(error.message, "파일 업로드가 실패했습니다.");
        return {
          success: false,
          message: "파일 업로드가 실패했습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["Account"],
        description: "User Profile Image Upload",
      },
      body: t.Object({
        phoneNumber: t.Optional(
          t.String({
            description: "Phone Number",
            error: "Phone Number is required",
          }),
        ),
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        profileImage: t.Optional(
          t.File({
            description: "User Profile Image File",
            error: "User Profile Image File is required",
            type: ["image/png", "image/jpg", "image/jpeg"],
          }),
        ),
        nickName: t.Optional(
          t.String({
            description: "User nickname",
            error: "Nickname is required",
            minLength: 1,
            maxLength: 20,
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
