import { printLLAMIASCII } from "../lib/ascii";
import { createApp } from "./app";
import dotenv from "dotenv";
import "@/lib/polyfill/text-decoder-stream";

// 서버리스 환경 감지 개선 (여러 환경 변수 확인)
const isServerless = Boolean(
  process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_REGION,
);

// 서버리스가 아닌 경우에만 실행 (기존 코드 유지)
if (!isServerless) {
  void (async function () {
    console.clear();

    // * Print initialization message
    printLLAMIASCII("🚀 Initializing API server...");

    // * Load environment variables
    dotenv.config();

    // * Create the app
    const app = await createApp();

    console.log(
      `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
    );
  })();
}

// 서버리스 환경을 위한 핸들러 (오류 처리 추가)
export default async (req: Request) => {
  try {
    // 환경 변수 로드
    dotenv.config();

    // 디버깅을 위한 로그
    console.log("서버리스 함수 실행 - 환경 변수:", {
      vercel: process.env.VERCEL,
      vercelEnv: process.env.VERCEL_ENV,
      vercelRegion: process.env.VERCEL_REGION,
      nodeEnv: process.env.NODE_ENV,
    });

    // 앱 생성 (서버리스 모드)
    const app = await createApp(true);

    // 요청 처리
    return app.handle(req);
  } catch (error) {
    console.error("서버리스 함수 오류:", error);

    // 상세한 오류 정보 반환
    return new Response(
      JSON.stringify({
        error: "서버 오류가 발생했습니다",
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
