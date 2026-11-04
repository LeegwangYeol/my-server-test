import { describe, expect, test, beforeAll } from "bun:test";
import { createApp } from "../src/app";
import { Elysia } from "elysia";

type App = Elysia<any, any, any, any, any, any, any, any>;

const postJson = (app: App, path: string, body: unknown, extraHeaders: Record<string, string> = {}) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("Global HTTP Body Size Limit", () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp(true);
  });

  test("rejects multi-byte body exceeding 1MB byte length but within 1MB char length with HTTP 413", async () => {
    const VALID_WIDGET_ID = "registered-valid-widget";
    // "가" is 3 bytes in UTF-8.
    // 400,000 "가"s = 400,000 characters. 400,000 * 3 = 1,200,000 bytes (> 1MB limit).
    const giantPayload = JSON.stringify({
      widgetId: VALID_WIDGET_ID,
      message: "Small message",
      padding: "가".repeat(400_000),
    });
    const res = await postJson(app, "/v2/ask", giantPayload);
    expect(res.status).toBe(413);
  });
});
