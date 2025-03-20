import { printLLAMIASCII } from "../lib/ascii";
import { createApp } from "./app";
import dotenv from "dotenv";
import "@/lib/polyfill/text-decoder-stream";

// 서버리스 환경 감지
const isServerless = process.env.VERCEL === '1';

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

// 서버리스 환경을 위한 핸들러
export default async (req: Request) => {
  // 환경 변수 로드
  dotenv.config();
  
  // 앱 생성 (서버리스 모드)
  const app = await createApp(true);
  
  // 요청 처리
  return app.handle(req);
};
