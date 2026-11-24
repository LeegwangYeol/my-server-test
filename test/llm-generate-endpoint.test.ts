import { describe, expect, it, beforeAll } from "bun:test";
import { createApp } from "../src/app";

type App = Awaited<ReturnType<typeof createApp>>;

describe("POST /v2/admin/llm/generate — Central Multimodal LLM Gateway", () => {
  let app: App;
  const TEST_TOKEN = "test-admin-secret-token";

  beforeAll(async () => {
    process.env.ADMIN_TOKEN = TEST_TOKEN;
    app = await createApp(true);
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("http://localhost/v2/admin/llm/generate", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("rejects missing or invalid X-Admin-Token with 401", async () => {
    const r1 = await app.handle(post({ prompt: "hello" }));
    expect(r1.status).toBe(401);
    const r2 = await app.handle(post({ prompt: "hello" }, { "x-admin-token": "wrong" }));
    expect(r2.status).toBe(401);
  });

  it("rejects empty prompt with 400", async () => {
    const res = await app.handle(post({ prompt: "   " }, { "x-admin-token": TEST_TOKEN }));
    expect(res.status).toBe(400);
  });

  it("blocks SSRF private/metadata/non-HTTPS imageUrls with 400 before network socket", async () => {
    process.env.LLM_PROVIDER = "gemini";
    process.env.LLM_API_KEY = "AIzaTestDummyKey123456";
    for (const bad of [
      "http://example.com/a.jpg",
      "https://169.254.169.254/latest/meta-data/",
      "https://127.0.0.1/a.jpg",
      "https://192.168.0.1/a.jpg",
      "https://localhost/a.jpg",
      "data:text/html;base64,PGh0bWw+",
    ]) {
      const res = await app.handle(
        post({ prompt: "작업 초안", imageUrls: [bad] }, { "x-admin-token": TEST_TOKEN }),
      );
      expect(res.status).toBe(400);
    }
  });
});
