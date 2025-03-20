import { printLLAMIASCII } from "../lib/ascii";
import { createApp } from "./app";
import dotenv from "dotenv";
import "@/lib/polyfill/text-decoder-stream";

void (async function () {
  console.clear();

  // * Print initialization message
  printLLAMIASCII("🚀 Initializing LLAMI API server...");

  // * Load environment variables
  dotenv.config();

  // * Create the app
  const app = await createApp();

  console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
  );
})();
