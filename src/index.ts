import { printLLAMIASCII } from "../lib/ascii";
import { createApp } from "./app";
import dotenv from "dotenv";
// 상대 경로로 변경하여 경로 별칭 문제 해결
import "../lib/polyfill/text-decoder-stream";

// 일반 서버 코드만 유지
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

// 서버리스 환경을 위해 serverless.ts 파일로 코드 이동
// 이 파일은 일반 서버 실행용으로만 사용됨
