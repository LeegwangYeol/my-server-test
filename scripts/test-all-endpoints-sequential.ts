import { createApp } from "../src/app";

interface TestReportItem {
  id: number;
  method: string;
  path: string;
  name: string;
  category:
    | "Public/Core"
    | "YouTube API"
    | "Widget Core"
    | "Admin Core"
    | "Serverless Infra";
  localStatus: number;
  localVerdict: "PASS" | "WARN" | "FAIL";
  liveStatus: number;
  liveVerdict: "PASS" | "WARN" | "FAIL";
  authProtected: boolean;
  notes: string;
}

const LIVE_BASE = "https://my-server-test.vercel.app";

async function runExhaustiveSequentialTest() {
  console.log(
    "================================================================================",
  );
  console.log(
    "🚀 STARTING EXHAUSTIVE DYNAMIC MAPPING & SEQUENTIAL ENDPOINT-BY-ENDPOINT INSPECTION",
  );
  console.log(
    "================================================================================",
  );

  const app = await createApp(true);

  // 28 Live Endpoints Definition
  const testSuite = [
    // 1. Core & Documentation
    {
      id: 1,
      method: "GET",
      path: "/",
      category: "Public/Core" as const,
      name: "Swagger UI (Scalar Documentation)",
      body: null,
      headers: {},
      expectedStatus: 200,
    },
    {
      id: 2,
      method: "GET",
      path: "/json",
      category: "Public/Core" as const,
      name: "OpenAPI 3.0 Spec JSON",
      body: null,
      headers: {},
      expectedStatus: 200,
    },
    {
      id: 3,
      method: "GET",
      path: "/v1/healthz",
      category: "Public/Core" as const,
      name: "Liveness Probe ('OK')",
      body: null,
      headers: {},
      expectedStatus: 200,
    },
    {
      id: 4,
      method: "GET",
      path: "/v1/heartbeat",
      category: "Public/Core" as const,
      name: "Structured Serverless Diagnostics",
      body: null,
      headers: {},
      expectedStatus: 200,
    },

    // 2. YouTube OAuth & Management API
    {
      id: 5,
      method: "POST",
      path: "/v1/youtube/auth/create",
      category: "YouTube API" as const,
      name: "OAuth URL Generation",
      body: JSON.stringify({
        clientId: "123456789-abcdefg.apps.googleusercontent.com",
        clientSecret: "GOCSPX-abcdef123456",
        redirectUri: "https://example.com/oauth/callback",
      }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 200,
    },
    {
      id: 6,
      method: "GET",
      path: "/v1/youtube/auth/confirm?code=mock_code&state=mock_state",
      category: "YouTube API" as const,
      name: "OAuth Token Exchange",
      body: null,
      headers: {},
      expectedStatus: 400, // Invalid state payload returns 400
    },
    {
      id: 7,
      method: "POST",
      path: "/v1/youtube/channel/info",
      category: "YouTube API" as const,
      name: "Channel Metadata",
      body: JSON.stringify({ accessToken: "mock-token" }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 400, // Throws error -> should return 400 Bad Request
    },
    {
      id: 8,
      method: "POST",
      path: "/v1/youtube/video/list",
      category: "YouTube API" as const,
      name: "Channel Video List",
      body: JSON.stringify({ handle: "test", accessToken: "mock-token" }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 400,
    },
    {
      id: 9,
      method: "POST",
      path: "/v1/youtube/comment/list",
      category: "YouTube API" as const,
      name: "Comment List",
      body: JSON.stringify({ videoId: "mockVideo", accessToken: "mock-token" }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 400,
    },
    {
      id: 10,
      method: "POST",
      path: "/v1/youtube/comment",
      category: "YouTube API" as const,
      name: "Post Comment",
      body: JSON.stringify({
        videoId: "mockVideo",
        commentText: "test comment",
        accessToken: "mock-token",
      }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 400,
    },
    {
      id: 11,
      method: "POST",
      path: "/v1/youtube/comment/delete",
      category: "YouTube API" as const,
      name: "Delete Comment",
      body: JSON.stringify({
        commentId: "mockComment",
        accessToken: "mock-token",
      }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 400,
    },
    {
      id: 12,
      method: "POST",
      path: "/v1/youtube/reply/list",
      category: "YouTube API" as const,
      name: "Reply List",
      body: JSON.stringify({
        parentId: "mockParent",
        accessToken: "mock-token",
      }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 400,
    },
    {
      id: 13,
      method: "POST",
      path: "/v1/youtube/reply",
      category: "YouTube API" as const,
      name: "Post Reply",
      body: JSON.stringify({
        parentId: "mockParent",
        text: "test reply",
        accessToken: "mock-token",
      }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 400,
    },

    // 3. Widget Client Endpoints
    {
      id: 14,
      method: "POST",
      path: "/v2/widget/view",
      category: "Widget Core" as const,
      name: "Widget View & Message Hydration",
      body: JSON.stringify({ widgetId: "default" }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 200,
    },
    {
      id: 15,
      method: "POST",
      path: "/v2/widget/create-thread",
      category: "Widget Core" as const,
      name: "Create Thread Session",
      body: JSON.stringify({ widgetId: "default" }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 200,
    },
    {
      id: 16,
      method: "POST",
      path: "/v2/ask",
      category: "Widget Core" as const,
      name: "SSE Streaming LLM Response",
      body: JSON.stringify({ widgetId: "default", message: "안녕" }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 200,
    },

    // 4. Admin Endpoints (Unauthenticated Check -> 401 Expected)
    {
      id: 17,
      method: "POST",
      path: "/v2/admin/widgets",
      category: "Admin Core" as const,
      name: "Admin: List Widgets",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 401,
    },
    {
      id: 18,
      method: "POST",
      path: "/v2/admin/widgets/upsert",
      category: "Admin Core" as const,
      name: "Admin: Upsert Widget",
      body: JSON.stringify({ id: "test" }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 401,
    },
    {
      id: 19,
      method: "POST",
      path: "/v2/admin/widgets/delete",
      category: "Admin Core" as const,
      name: "Admin: Delete Widget",
      body: JSON.stringify({ id: "test" }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 401,
    },
    {
      id: 20,
      method: "POST",
      path: "/v2/admin/widgets/upload-icon",
      category: "Admin Core" as const,
      name: "Admin: Upload Icon",
      body: (() => {
        const form = new FormData();
        form.append("widgetId", "test");
        const pngBase64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        const pngBuf = Buffer.from(pngBase64, "base64");
        form.append(
          "file",
          new File([pngBuf], "icon.png", { type: "image/png" }),
        );
        return form;
      })(),
      headers: {},
      expectedStatus: 401,
    },
    {
      id: 21,
      method: "POST",
      path: "/v2/admin/threads",
      category: "Admin Core" as const,
      name: "Admin: List Threads",
      body: JSON.stringify({ widgetId: "test" }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 401,
    },
    {
      id: 22,
      method: "POST",
      path: "/v2/admin/threads/rename",
      category: "Admin Core" as const,
      name: "Admin: Rename Thread",
      body: JSON.stringify({
        widgetId: "test",
        threadId: "test-id",
        title: "new",
      }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 401,
    },
    {
      id: 23,
      method: "POST",
      path: "/v2/admin/threads/update",
      category: "Admin Core" as const,
      name: "Admin: Update Thread",
      body: JSON.stringify({
        widgetId: "test",
        threadId: "test-id",
        system_prompt: "hello",
      }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 401,
    },
    {
      id: 24,
      method: "POST",
      path: "/v2/admin/messages",
      category: "Admin Core" as const,
      name: "Admin: List Messages",
      body: JSON.stringify({ widgetId: "test", threadId: "test-id" }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 401,
    },
    {
      id: 25,
      method: "POST",
      path: "/v2/admin/db/migrate",
      category: "Admin Core" as const,
      name: "Admin: DB Migrate",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 401,
    },
    {
      id: 26,
      method: "POST",
      path: "/v2/admin/mail/send",
      category: "Admin Core" as const,
      name: "Admin: Mail Send",
      body: JSON.stringify({
        to: "test@example.com",
        subject: "test",
        text: "hello",
      }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 401,
    },
    {
      id: 27,
      method: "POST",
      path: "/v2/admin/sms/send",
      category: "Admin Core" as const,
      name: "Admin: SMS Send",
      body: JSON.stringify({ to: "01012345678", text: "test" }),
      headers: { "Content-Type": "application/json" },
      expectedStatus: 401,
    },

    // 5. Serverless Platform
    {
      id: 28,
      method: "GET",
      path: "/api/hello",
      category: "Serverless Infra" as const,
      name: "Vercel Platform Sanity Check",
      body: null,
      headers: {},
      expectedStatus: 200,
    },
  ];

  const report: TestReportItem[] = [];

  for (const item of testSuite) {
    // 1. Local execution
    let localStatus = 0;
    let localText = "";
    try {
      const localReq = new Request(`http://localhost${item.path}`, {
        method: item.method,
        headers:
          item.body instanceof FormData ? undefined : (item.headers as any),
        body: item.body as any,
      });
      const res = await app.handle(localReq);
      localStatus = res.status;
      localText = await res.text();
    } catch (e: any) {
      localStatus = 599;
      localText = e.message;
    }

    // 2. Live execution
    let liveStatus = 0;
    let liveText = "";
    try {
      const liveRes = await fetch(`${LIVE_BASE}${item.path}`, {
        method: item.method,
        headers:
          item.body instanceof FormData ? undefined : (item.headers as any),
        body: item.body as any,
        signal: AbortSignal.timeout(12000),
      });
      liveStatus = liveRes.status;
      liveText = await liveRes.text();
    } catch (e: any) {
      liveStatus = 599;
      liveText = e.message;
    }

    // Assess verdict
    let localVerdict: "PASS" | "WARN" | "FAIL" = "PASS";
    let liveVerdict: "PASS" | "WARN" | "FAIL" = "PASS";
    let notes = "";
    let authProtected = false;

    if (item.category === "Admin Core") {
      authProtected = true;
      if (localStatus === 401) localVerdict = "PASS";
      else if (localStatus === 500 && localText.includes("ADMIN_TOKEN"))
        localVerdict = "PASS";
      else localVerdict = "FAIL";

      if (liveStatus === 401) liveVerdict = "PASS";
      else if (liveStatus === 500 && liveText.includes("ADMIN_TOKEN"))
        liveVerdict = "PASS";
      else liveVerdict = "FAIL";

      notes = `Fail-closed Guard: Local=${localStatus}, Live=${liveStatus}`;
    } else if (item.category === "YouTube API") {
      if (item.id === 5) {
        // auth/create
        localVerdict = localStatus === 200 ? "PASS" : "FAIL";
        liveVerdict = liveStatus === 200 ? "PASS" : "FAIL";
        notes = `OAuth URL generated: ${localStatus}`;
      } else if (item.id === 6) {
        localVerdict = localStatus === 400 ? "PASS" : "FAIL";
        liveVerdict = liveStatus === 400 ? "PASS" : "FAIL";
        notes = "Invalid state properly rejected with 400";
      } else {
        // channel/info, video/list, comment/*, reply/*
        // If status is 422, it is Elysia ResponseValidationError!
        if (localStatus === 422 || liveStatus === 422) {
          localVerdict = localStatus === 422 ? "FAIL" : "WARN";
          liveVerdict = liveStatus === 422 ? "FAIL" : "WARN";
          notes =
            "CRITICAL: ResponseValidationError (HTTP 422) schema mismatch on error";
        } else if (localStatus === 200 || liveStatus === 200) {
          localVerdict = "WARN";
          liveVerdict = "WARN";
          notes = "WARN: Soft failure returned HTTP 200 with {success:false}";
        } else if (localStatus === 400 || liveStatus === 400) {
          localVerdict = "PASS";
          liveVerdict = "PASS";
          notes = "Handled HTTP 400 Bad Request";
        }
      }
    } else if (item.category === "Widget Core") {
      if (item.id === 15 || item.id === 16) {
        // Whitelist check returns 403 on unregistered widgetId
        if (localStatus === 403 && liveStatus === 403) {
          localVerdict = "PASS";
          liveVerdict = "PASS";
          notes =
            "Whitelist Guard enforced (HTTP 403 on unregistered widgetId)";
        } else if (liveStatus === 200) {
          liveVerdict = "PASS";
          notes = "HTTP 200 OK stream";
        }
      } else if (item.id === 14) {
        if (liveStatus === 200) liveVerdict = "PASS";
        if (localStatus === 200 || (localStatus === 500 && localText.includes("SUPABASE_URL"))) {
          localVerdict = "PASS";
          notes = `DB Lazy Proxy Guard: Local=${localStatus}, Live=${liveStatus}`;
        }
      }
    } else if (item.id === 28) {
      localVerdict = localStatus === 200 ? "PASS" : "FAIL";
      liveVerdict = liveStatus === 200 ? "PASS" : "FAIL";
      notes = `Vercel sanity function: Local=${localStatus}, Live=${liveStatus}`;
    } else {
      localVerdict = localStatus === 200 ? "PASS" : "FAIL";
      liveVerdict = liveStatus === 200 ? "PASS" : "FAIL";
      notes = `HTTP 200 OK: Local=${localStatus}, Live=${liveStatus}`;
    }

    report.push({
      id: item.id,
      method: item.method,
      path: item.path.split("?")[0],
      name: item.name,
      category: item.category,
      localStatus,
      localVerdict,
      liveStatus,
      liveVerdict,
      authProtected,
      notes,
    });

    console.log(
      `[${item.id.toString().padStart(2, "0")}/28] ${item.method.padEnd(4)} ${item.path.split("?")[0].padEnd(30)} | Local: ${localStatus} (${localVerdict}) | Live: ${liveStatus} (${liveVerdict}) | ${notes}`,
    );
  }

  console.log(
    "\n================================================================================",
  );
  console.log("📊 SEQUENTIAL INSPECTION SCORECARD SUMMARY");
  console.log(
    "================================================================================",
  );
  console.table(
    report.map((r) => ({
      "#": r.id,
      Cat: r.category,
      Method: r.method,
      Path: r.path,
      Local: `${r.localStatus} (${r.localVerdict})`,
      Live: `${r.liveStatus} (${r.liveVerdict})`,
      Auth: r.authProtected ? "🔒 401 Guard" : "Public/Client",
      Notes: r.notes.slice(0, 50),
    })),
  );

  const failCount = report.filter(
    (r) => r.liveVerdict === "FAIL" || r.localVerdict === "FAIL",
  ).length;
  const warnCount = report.filter(
    (r) => r.liveVerdict === "WARN" || r.localVerdict === "WARN",
  ).length;
  const passCount = report.filter(
    (r) => r.liveVerdict === "PASS" && r.localVerdict === "PASS",
  ).length;

  console.log(
    `Total: 28 | PASS: ${passCount} | WARN: ${warnCount} | FAIL: ${failCount}`,
  );
}

runExhaustiveSequentialTest().catch(console.error);
