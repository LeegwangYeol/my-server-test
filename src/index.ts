import { createApp } from "./app";
import dotenv from "dotenv";
// 상대 경로로 변경하여 경로 별칭 문제 해결
import "../lib/polyfill/text-decoder-stream";

// 일반 서버 코드만 유지
void (async function () {
  console.clear();

  // * Print initialization message
  console.log("🚀 Initializing API server...");

  // * Load environment variables
  dotenv.config();

  // * Create the app
  const app = await createApp();

  console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
  );
})();

// 서버리스 진입점은 lambda-src/handler.ts (esbuild → api/index.js)
// 이 파일은 로컬 dev(app.listen) 전용
