// scripts/verify-live-28-endpoints.mjs
// Live Vercel Production 28-Endpoint Verification Script

const BASE_URL = process.env.BASE_URL || "https://my-server-test.vercel.app";

const results = [];

async function testEndpoint(id, name, path, method, headers = {}, body = null, expectedStatuses = [200]) {
  const start = performance.now();
  let status = 0;
  let statusText = "";
  let respBody = "";
  let error = null;

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    statusText = res.statusText;
    const text = await res.text();
    respBody = text.slice(0, 120);
  } catch (err) {
    error = err.message;
  }

  const duration = (performance.now() - start).toFixed(1);
  const pass = expectedStatuses.includes(status);

  results.push({
    id,
    name,
    method,
    path,
    status,
    pass,
    duration: `${duration}ms`,
    snippet: respBody.replace(/[\r\n]+/g, " "),
    error,
  });

  console.log(
    `[${pass ? "PASS" : "FAIL"}] [${id}/28] ${method} ${path} -> HTTP ${status} (${duration}ms) ${pass ? "" : `(Expected: ${expectedStatuses.join(",")})`}`
  );
}

async function run() {
  console.log(`=== LIVE VERCEL PRODUCTION 28-ENDPOINT SEQUENTIAL AUDIT ===`);
  console.log(`Target: ${BASE_URL}\n`);

  // Category 1: Public & Core Documentation
  await testEndpoint("01", "Swagger UI / Scalar API Reference", "/", "GET", {}, null, [200]);
  await testEndpoint("02", "OpenAPI Spec JSON", "/json", "GET", {}, null, [200]);
  await testEndpoint("03", "Health Liveness Probe", "/v1/healthz", "GET", {}, null, [200]);
  await testEndpoint("04", "Heartbeat Diagnostic JSON", "/v1/heartbeat", "GET", {}, null, [200]);

  // Category 2: YouTube OAuth & Management API
  await testEndpoint(
    "05",
    "YouTube OAuth URL Generation",
    "/v1/youtube/auth/create",
    "POST",
    {},
    {
      clientId: "123456789-abcdefg.apps.googleusercontent.com",
      clientSecret: "GOCSPX-abcdef123456",
      redirectUri: "https://example.com/oauth/callback",
    },
    [200]
  );
  await testEndpoint("06", "YouTube OAuth Callback Guard", "/v1/youtube/auth/confirm", "GET", {}, null, [400]);
  await testEndpoint(
    "07",
    "YouTube Channel Metadata Info",
    "/v1/youtube/channel/info",
    "POST",
    {},
    { accessToken: "mock-token-xyz" },
    [400]
  );
  await testEndpoint(
    "08",
    "YouTube Video Listing",
    "/v1/youtube/video/list",
    "POST",
    {},
    { handle: "test_handle", accessToken: "mock-token-xyz" },
    [400]
  );
  await testEndpoint(
    "09",
    "YouTube Comment Threads",
    "/v1/youtube/comment/list",
    "POST",
    {},
    { videoId: "mock_vid", accessToken: "mock-token-xyz" },
    [400]
  );
  await testEndpoint(
    "10",
    "YouTube Add Comment",
    "/v1/youtube/comment",
    "POST",
    {},
    { videoId: "mock_vid", commentText: "Test comment", accessToken: "mock-token-xyz" },
    [400]
  );
  await testEndpoint(
    "11",
    "YouTube Delete Comment",
    "/v1/youtube/comment/delete",
    "POST",
    {},
    { commentId: "c_123", accessToken: "mock-token-xyz" },
    [400]
  );
  await testEndpoint(
    "12",
    "YouTube Reply Listing",
    "/v1/youtube/reply/list",
    "POST",
    {},
    { parentId: "p_123", accessToken: "mock-token-xyz" },
    [400]
  );
  await testEndpoint(
    "13",
    "YouTube Post Reply",
    "/v1/youtube/reply",
    "POST",
    {},
    { parentId: "p_123", text: "Test reply", accessToken: "mock-token-xyz" },
    [400]
  );

  // Category 3: Widget Core Client API
  await testEndpoint("14", "Widget View Hydration", "/v2/widget/view", "POST", {}, { widgetId: "muryen" }, [200]);
  await testEndpoint(
    "15",
    "Widget Create Thread (Unregistered Guard)",
    "/v2/widget/create-thread",
    "POST",
    {},
    { widgetId: "unregistered_tenant" },
    [403]
  );
  await testEndpoint(
    "16",
    "Widget Ask LLM Stream (Unregistered Guard)",
    "/v2/ask",
    "POST",
    {},
    { widgetId: "unregistered_tenant", message: "Hello" },
    [403]
  );

  // Category 4: Admin Core Management API (Fail-Closed 401 Guards)
  await testEndpoint("17", "Admin Widgets List (Unauthorized Guard)", "/v2/admin/widgets", "POST", {}, {}, [401]);
  await testEndpoint(
    "18",
    "Admin Widget Upsert (Unauthorized Guard)",
    "/v2/admin/widgets/upsert",
    "POST",
    {},
    { id: "test" },
    [401]
  );
  await testEndpoint(
    "19",
    "Admin Widget Delete (Unauthorized Guard)",
    "/v2/admin/widgets/delete",
    "POST",
    {},
    { id: "test" },
    [401]
  );
  // 20. Upload icon with multipart/form-data to test auth guard
  const form = new FormData();
  form.append("widgetId", "test");
  form.append("file", new Blob(["fake-image-bytes"], { type: "image/png" }), "icon.png");
  
  const start20 = performance.now();
  let status20 = 0;
  let pass20 = false;
  try {
    const res20 = await fetch(`${BASE_URL}/v2/admin/widgets/upload-icon`, {
      method: "POST",
      body: form,
    });
    status20 = res20.status;
    pass20 = status20 === 401;
  } catch (err) {
    status20 = 0;
  }
  const dur20 = (performance.now() - start20).toFixed(1);
  console.log(`[${pass20 ? "PASS" : "FAIL"}] [20/28] POST /v2/admin/widgets/upload-icon -> HTTP ${status20} (${dur20}ms)`);
  results.push({ id: "20", name: "Admin Upload Icon", method: "POST", path: "/v2/admin/widgets/upload-icon", status: status20, pass: pass20, duration: `${dur20}ms` });
  await testEndpoint("21", "Admin Threads List (Unauthorized Guard)", "/v2/admin/threads", "POST", {}, { widgetId: "test" }, [401]);
  await testEndpoint(
    "22",
    "Admin Thread Rename (Unauthorized Guard)",
    "/v2/admin/threads/rename",
    "POST",
    {},
    { widgetId: "test", threadId: "uuid", title: "New" },
    [401]
  );
  await testEndpoint(
    "23",
    "Admin Thread Update (Unauthorized Guard)",
    "/v2/admin/threads/update",
    "POST",
    {},
    { widgetId: "test", threadId: "uuid", system_prompt: "p" },
    [401]
  );
  await testEndpoint(
    "24",
    "Admin Messages List (Unauthorized Guard)",
    "/v2/admin/messages",
    "POST",
    {},
    { widgetId: "test", threadId: "uuid" },
    [401]
  );
  await testEndpoint("25", "Admin DB Migrate (Unauthorized Guard)", "/v2/admin/db/migrate", "POST", {}, { dryRun: true }, [401]);
  await testEndpoint(
    "26",
    "Admin Mail Send (Unauthorized Guard)",
    "/v2/admin/mail/send",
    "POST",
    {},
    { to: "test@example.com", subject: "Test", text: "Text" },
    [401]
  );
  await testEndpoint(
    "27",
    "Admin SMS Send (Unauthorized Guard)",
    "/v2/admin/sms/send",
    "POST",
    {},
    { to: "01012345678", text: "Test SMS" },
    [401]
  );

  // Category 5: Serverless Platform Sanity
  await testEndpoint("28", "Serverless Hello Sanity", "/api/hello", "GET", {}, null, [200]);

  // Dormant Endpoints Spot Check (Should all return 404)
  console.log(`\n=== DORMANT UNMOUNTED ROUTE SPOT CHECK (EXPECT 404) ===`);
  await testEndpoint("D1", "Legacy Account Endpoint", "/v1/account", "POST", {}, {}, [404]);
  await testEndpoint("D2", "Legacy Billing Endpoint", "/v1/billing", "POST", {}, {}, [404]);
  await testEndpoint("D3", "Legacy Payment Endpoint", "/v1/payment", "POST", {}, {}, [404]);
  await testEndpoint("D4", "Legacy Chat Endpoint", "/v1/chat", "POST", {}, {}, [404]);
  await testEndpoint("D5", "Legacy Workspace Endpoint", "/v1/workspace", "POST", {}, {}, [404]);

  const passedCount = results.filter((r) => r.pass).length;
  console.log(`\n========================================`);
  console.log(`FINAL SCORE: ${passedCount} / ${results.length} PASSED`);
  console.log(`========================================`);
}

run();
