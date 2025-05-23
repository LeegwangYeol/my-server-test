import { createApp } from "./app";
import dotenv from "dotenv";

// 필수 폴리필만 가져오기 (상대 경로 사용)
try {
  require("../lib/polyfill/text-decoder-stream");
} catch (e) {
  // 폴리필 로드 실패 시 무시
  console.warn("폴리필 로드 실패:", e.message);
}

// 간소화된 서버리스 핸들러
export default async (req: Request) => {
  try {
    // 환경 변수 로드
    dotenv.config();

    // 앱 생성 (서버리스 모드)
    const app = await createApp(true);

    // 요청 처리
    return app.handle(req);
  } catch (error) {
    // 간소화된 오류 응답
    console.error("서버리스 함수 오류:", error.message);

    return new Response(
      JSON.stringify({
        error: "서버 오류가 발생했습니다",
        message: error.message,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
