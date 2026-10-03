import { describe, expect, it, beforeAll } from "bun:test";
import { createApp } from "../src/app";

type App = Awaited<ReturnType<typeof createApp>>;

describe("Sequential 28 Endpoints Full Verification Suite", () => {
  let app: App;

  beforeAll(async () => {
    process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || "test-admin-secret-token";
    process.env.MAIL_SEND_TOKEN = process.env.MAIL_SEND_TOKEN || "test-mail-token";
    app = await createApp(true);
  });

  const req = (path: string, init?: RequestInit) =>
    new Request(`http://localhost${path}`, init);

  const jsonPost = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    req(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  // ==========================================
  // Section 1: Public & Documentation (4 endpoints)
  // ==========================================
  describe("Category 1: Public & Core Documentation", () => {
    it("[01/28] GET / -> 200 OK (Swagger UI / Scalar API Reference)", async () => {
      const res = await app.handle(req("/"));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("API Reference");
    });

    it("[02/28] GET /json -> 200 OK (OpenAPI 3.0.3 Spec JSON)", async () => {
      const res = await app.handle(req("/json"));
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.openapi).toBe("3.0.3");
      expect(data.info.title).toBe("API Documentation");
      expect(data.paths).toBeDefined();
    });

    it("[03/28] GET /v1/healthz -> 200 OK ('OK' Liveness probe)", async () => {
      const res = await app.handle(req("/v1/healthz"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("OK");
    });

    it("[04/28] GET /v1/heartbeat -> 200 OK (Diagnostic JSON)", async () => {
      const res = await app.handle(req("/v1/heartbeat"));
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.status).toBe("alive");
      expect(data.timestamp).toBeDefined();
      expect(typeof data.uptimeMs).toBe("number");
      expect(typeof data.node).toBe("string");
    });
  });

  // ==========================================
  // Section 2: YouTube API (9 endpoints)
  // ==========================================
  describe("Category 2: YouTube OAuth & Management API", () => {
    it("[05/28] POST /v1/youtube/auth/create -> 200 OK (OAuth URL generation & validation)", async () => {
      // 1. Valid payload
      const validRes = await app.handle(
        jsonPost("/v1/youtube/auth/create", {
          clientId: "123456789-abcdefg.apps.googleusercontent.com",
          clientSecret: "GOCSPX-abcdef123456",
          redirectUri: "https://example.com/oauth/callback",
        }),
      );
      expect(validRes.status).toBe(200);
      const data = (await validRes.json()) as any;
      expect(data.success).toBe(true);
      expect(data.data.url).toContain("accounts.google.com");

      // 2. Schema validation check (Invalid clientId pattern) -> 422
      const invalidRes = await app.handle(
        jsonPost("/v1/youtube/auth/create", {
          clientId: "invalid-client-id",
          clientSecret: "GOCSPX-123",
          redirectUri: "https://example.com",
        }),
      );
      expect(invalidRes.status).toBe(422);
    });

    it("[06/28] GET /v1/youtube/auth/confirm -> 400 Bad Request (OAuth token exchange guard)", async () => {
      // Missing query params -> 400
      const res1 = await app.handle(req("/v1/youtube/auth/confirm"));
      expect(res1.status).toBe(400);
      const data1 = (await res1.json()) as any;
      expect(data1.success).toBe(false);

      // Malformed state -> 400
      const res2 = await app.handle(
        req("/v1/youtube/auth/confirm?code=mock_code&state=not-valid-base64-json"),
      );
      expect(res2.status).toBe(400);
      const data2 = (await res2.json()) as any;
      expect(data2.success).toBe(false);
    });

    it("[07/28] POST /v1/youtube/channel/info -> 400 / 422 (Channel metadata retrieval)", async () => {
      // Missing accessToken -> 422
      const missingRes = await app.handle(jsonPost("/v1/youtube/channel/info", {}));
      expect(missingRes.status).toBe(422);

      // Invalid token -> 400 handled error
      const res = await app.handle(
        jsonPost("/v1/youtube/channel/info", { accessToken: "mock-token-xyz" }),
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
    });

    it("[08/28] POST /v1/youtube/video/list -> 400 / 422 (Channel video listing)", async () => {
      // Missing body fields -> 422
      const missingRes = await app.handle(jsonPost("/v1/youtube/video/list", {}));
      expect(missingRes.status).toBe(422);

      // Invalid token -> 400 handled error
      const res = await app.handle(
        jsonPost("/v1/youtube/video/list", {
          handle: "test_handle",
          accessToken: "mock-token-xyz",
        }),
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
    });

    it("[09/28] POST /v1/youtube/comment/list -> 400 / 422 (Video comment threads)", async () => {
      // Missing videoId -> 422
      const missingRes = await app.handle(jsonPost("/v1/youtube/comment/list", {}));
      expect(missingRes.status).toBe(422);

      // Invalid token -> 400 handled error
      const res = await app.handle(
        jsonPost("/v1/youtube/comment/list", {
          videoId: "mock_vid",
          accessToken: "mock-token-xyz",
        }),
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
    });

    it("[10/28] POST /v1/youtube/comment -> 400 / 422 (Add video comment)", async () => {
      // Missing commentText -> 422
      const missingRes = await app.handle(
        jsonPost("/v1/youtube/comment", { videoId: "mock_vid", accessToken: "tok" }),
      );
      expect(missingRes.status).toBe(422);

      // Invalid token -> 400 handled error
      const res = await app.handle(
        jsonPost("/v1/youtube/comment", {
          videoId: "mock_vid",
          commentText: "Test comment",
          accessToken: "mock-token-xyz",
        }),
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
    });

    it("[11/28] POST /v1/youtube/comment/delete -> 400 / 422 (Delete comment)", async () => {
      // Missing commentId -> 422
      const missingRes = await app.handle(jsonPost("/v1/youtube/comment/delete", {}));
      expect(missingRes.status).toBe(422);

      // Invalid token -> 400 handled error
      const res = await app.handle(
        jsonPost("/v1/youtube/comment/delete", {
          commentId: "c_123",
          accessToken: "mock-token-xyz",
        }),
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
    });

    it("[12/28] POST /v1/youtube/reply/list -> 400 / 422 (Reply listing for comment)", async () => {
      // Missing parentId -> 422
      const missingRes = await app.handle(jsonPost("/v1/youtube/reply/list", {}));
      expect(missingRes.status).toBe(422);

      // Invalid token -> 400 handled error
      const res = await app.handle(
        jsonPost("/v1/youtube/reply/list", {
          parentId: "p_123",
          accessToken: "mock-token-xyz",
        }),
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
    });

    it("[13/28] POST /v1/youtube/reply -> 400 / 422 (Post reply to comment)", async () => {
      // Missing text -> 422
      const missingRes = await app.handle(
        jsonPost("/v1/youtube/reply", { parentId: "p_123", accessToken: "tok" }),
      );
      expect(missingRes.status).toBe(422);

      // Invalid token -> 400 handled error
      const res = await app.handle(
        jsonPost("/v1/youtube/reply", {
          parentId: "p_123",
          text: "Test reply",
          accessToken: "mock-token-xyz",
        }),
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
    });
  });

  // ==========================================
  // Section 3: Widget Client Endpoints (3 endpoints)
  // ==========================================
  describe("Category 3: Widget Core Client API", () => {
    it("[14/28] POST /v2/widget/view -> Tenant config & messages hydration", async () => {
      const res = await app.handle(
        jsonPost("/v2/widget/view", { widgetId: "muryen" }),
      );
      // Locally without live DB, returns either 200 or handled 500 DB proxy error
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(data.widget).toBeDefined();
      }
    });

    it("[15/28] POST /v2/widget/create-thread -> Whitelist Guard (403 unregistered)", async () => {
      // 1. Unregistered widgetId -> 403 Forbidden (Guard 2 Enforcement)
      const resUnregistered = await app.handle(
        jsonPost("/v2/widget/create-thread", { widgetId: "unregistered_tenant_123" }),
      );
      expect(resUnregistered.status).toBe(403);
      const unregData = (await resUnregistered.json()) as any;
      expect(unregData.success).toBe(false);
      expect(unregData.error).toBe("unregistered widget_id");

      // 2. Empty widgetId -> 403 Forbidden
      const resEmpty = await app.handle(
        jsonPost("/v2/widget/create-thread", { widgetId: "" }),
      );
      expect(resEmpty.status).toBe(403);
    });

    it("[16/28] POST /v2/ask -> Whitelist Guard & Payload Limits", async () => {
      // 1. Unregistered widgetId -> 403 Forbidden
      const resUnreg = await app.handle(
        jsonPost("/v2/ask", {
          widgetId: "unregistered_uuid",
          message: "안녕하세요",
        }),
      );
      expect(resUnreg.status).toBe(403);

      // 2. Message length > 4000 chars -> 413 Payload Too Large
      const resTooLong = await app.handle(
        jsonPost("/v2/ask", {
          widgetId: "muryen",
          message: "A".repeat(4001),
        }),
      );
      expect(resTooLong.status).toBe(413);
    });
  });

  // ==========================================
  // Section 4: Admin Core Endpoints (11 endpoints)
  // ==========================================
  describe("Category 4: Admin Core Management API (Fail-Closed 401 Guard)", () => {
    it("[17/28] POST /v2/admin/widgets -> 401 without valid token", async () => {
      const resNoAuth = await app.handle(jsonPost("/v2/admin/widgets", {}));
      expect(resNoAuth.status).toBe(401);

      const resWrongAuth = await app.handle(
        jsonPost("/v2/admin/widgets", {}, { "x-admin-token": "wrong-secret" }),
      );
      expect(resWrongAuth.status).toBe(401);
    });

    it("[18/28] POST /v2/admin/widgets/upsert -> 401 without valid token", async () => {
      const resNoAuth = await app.handle(
        jsonPost("/v2/admin/widgets/upsert", { id: "test-widget" }),
      );
      expect(resNoAuth.status).toBe(401);
    });

    it("[19/28] POST /v2/admin/widgets/delete -> 401 without valid token", async () => {
      const resNoAuth = await app.handle(
        jsonPost("/v2/admin/widgets/delete", { id: "test-widget" }),
      );
      expect(resNoAuth.status).toBe(401);
    });

    it("[20/28] POST /v2/admin/widgets/upload-icon -> 401 without valid token", async () => {
      const form = new FormData();
      form.append("widgetId", "test");
      form.append(
        "file",
        new File([new Uint8Array([1, 2, 3])], "icon.png", { type: "image/png" }),
      );
      const resNoAuth = await app.handle(
        new Request("http://localhost/v2/admin/widgets/upload-icon", {
          method: "POST",
          body: form,
        }),
      );
      expect(resNoAuth.status).toBe(401);
    });

    it("[21/28] POST /v2/admin/threads -> 401 without valid token", async () => {
      const resNoAuth = await app.handle(
        jsonPost("/v2/admin/threads", { widgetId: "test" }),
      );
      expect(resNoAuth.status).toBe(401);
    });

    it("[22/28] POST /v2/admin/threads/rename -> 401 without valid token", async () => {
      const resNoAuth = await app.handle(
        jsonPost("/v2/admin/threads/rename", {
          widgetId: "test",
          threadId: "uuid",
          title: "New Title",
        }),
      );
      expect(resNoAuth.status).toBe(401);
    });

    it("[23/28] POST /v2/admin/threads/update -> 401 without valid token", async () => {
      const resNoAuth = await app.handle(
        jsonPost("/v2/admin/threads/update", {
          widgetId: "test",
          threadId: "uuid",
          system_prompt: "test",
        }),
      );
      expect(resNoAuth.status).toBe(401);
    });

    it("[24/28] POST /v2/admin/messages -> 401 without valid token", async () => {
      const resNoAuth = await app.handle(
        jsonPost("/v2/admin/messages", {
          widgetId: "test",
          threadId: "uuid",
        }),
      );
      expect(resNoAuth.status).toBe(401);
    });

    it("[25/28] POST /v2/admin/db/migrate -> 401 without valid token", async () => {
      const resNoAuth = await app.handle(
        jsonPost("/v2/admin/db/migrate", { dryRun: true }),
      );
      expect(resNoAuth.status).toBe(401);
    });

    it("[26/28] POST /v2/admin/mail/send -> 401 without valid token", async () => {
      const resNoAuth = await app.handle(
        jsonPost("/v2/admin/mail/send", {
          to: "test@example.com",
          subject: "Test",
          text: "Test content",
        }),
      );
      expect(resNoAuth.status).toBe(401);
    });

    it("[27/28] POST /v2/admin/sms/send -> 401 without valid token", async () => {
      const resNoAuth = await app.handle(
        jsonPost("/v2/admin/sms/send", {
          to: "01012345678",
          text: "Test SMS",
        }),
      );
      expect(resNoAuth.status).toBe(401);
    });
  });

  // ==========================================
  // Section 5: Serverless Platform Sanity (1 endpoint)
  // ==========================================
  describe("Category 5: Serverless Infra & Parity", () => {
    it("[28/28] GET /api/hello -> 200 OK (Platform Health & Sanity)", async () => {
      const res = await app.handle(req("/api/hello"));
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.message).toBe("hello from vercel");
      expect(data.ts).toBeDefined();
    });
  });
});
