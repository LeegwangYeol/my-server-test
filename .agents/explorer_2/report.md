# Exhaustive Analysis Report: Routing, Endpoints, Authentication, and Request Lifecycles

**Target Repository**: `/Users/user/src/my-server-test`  
**Author**: Explorer 2 (Teamwork Explorer)  
**Date**: 2026-09-17  
**Scope**: All active endpoints, unmounted/inactive endpoints, routing architecture, authentication models, request/response lifecycles, `/v2/ask` SSE streaming, and YouTube OAuth data operations.

---

## 1. Executive Summary

`my-server-test` is an **Elysia (TypeScript) REST API server** deployed as a single CommonJS bundle (`api/index.js`) on **Vercel Node.js 20.x Serverless Functions**. The server serves two distinct active business domains:
1. **YouTube OAuth & Interaction API** (`/v1/youtube/*`): A stateless proxy for Google YouTube Data API v3 (channel lookup, upload video listings, comment insertion/deletion, reply management).
2. **Chat Widget Backend & Administration** (`/v2/*`): A multi-tenant conversational AI backend offering Server-Sent Events (SSE) streaming responses (`/v2/ask`), Supabase PostgreSQL thread/message persistence, custom persona configuration, file/icon asset storage, and administrative tooling (database migrations, transactional Naver SMTP email, and SMS).

Historically, the repository contained a large monolithic SaaS backend ("LLAMI SaaS") featuring user accounts, workspace multi-tenancy, billing with Toss Payments, web/SERP scraping, vector embeddings, Instagram/Kakao integrations, and WebSockets. In the current architecture, **all 21 legacy v1 modules remain unmounted** in `src/endpoints/v1/v1-endpoints.ts`, intentionally isolating the active runtime surface to YouTube and v2 Widget features.

---

## 2. Server Architecture & Request/Response Lifecycle

### 2.1 Serverless Bridge (`lambda-src/handler.ts`)

Because Elysia is built natively on Web Standards (`Request` and `Response`), while Vercel's Node runtime passes standard Node.js `http.IncomingMessage` and `http.ServerResponse` objects, a bidirectional adapter bridges the environments:

```
Vercel Edge Gateway
        │
        ▼ HTTP Request (Node req: IncomingMessage)
[lambda-src/handler.ts]
        │
        ├── 1. toWebRequest(req):
        │      Constructs web-standard `new Request(url, { method, headers, duplex: "half", body })`
        │      Resolves proto via `x-forwarded-proto` and host via `req.headers.host`
        │
        ├── 2. app.handle(webReq):
        │      Dispatches to Elysia application instance (cached app singleton via getApp())
        │      Executes Elysia middleware pipeline & route handler
        │
        ▼ Web Response (webRes: Response)
        │
        └── 3. writeWebResponse(res, webRes):
               Copies status code (`res.statusCode = webRes.status`)
               Copies headers (`res.setHeader(k, v)`)
               Reads response body stream chunks (`webRes.body.getReader()`) and pipes via `res.write(value)`
               Calls `res.end()` on completion
```

### 2.2 Global Middleware & Plugin Pipeline (`src/app.ts`)

When `createApp(serverless = true)` is invoked, middleware and plugins are registered in strict sequential order:

1. **CORS Preflight Hook (`app.onAfterHandle`)**:
   - Inspects `request.method === "OPTIONS"`.
   - If `Access-Control-Allow-Headers` was set to wildcard `*`, dynamically replaces it with `request.headers.get("Access-Control-Request-Headers") ?? ""` to satisfy strict browser CORS requirements when credentials or specific headers are sent.
2. **CORS Plugin (`@elysiajs/cors`)**:
   - Configured with `origin: true` (reflects request origin).
3. **Swagger / OpenAPI Documentation (`@elysiajs/swagger`)**:
   - Mounted at path `/`.
   - Uses Scalar UI standalone bundle from CDN (`https://unpkg.com/@scalar/api-reference@1.25.52/dist/browser/standalone.js`).
   - Tags defined: `API`, `Health`, `YouTube`.
4. **Endpoint Group Registration**:
   - `v1Endpoints(app)`: Registers `/v1` group (mounting `v1Youtube`).
   - `v2WidgetEndpoints(app)`: Registers `/v2` group (mounting widget public and admin endpoints).
   - `v2MailEndpoints(app)`: Registers `/v2/admin/mail/send`.
   - `v2SmsEndpoints(app)`: Registers `/v2/admin/sms/send`.
   - `healthzEndpoint(app)`: Registers `/v1/healthz` and `/v1/heartbeat`.
5. **Port Listening**:
   - If `!serverless`, executes `app.listen(process.env.PORT ?? 3000)` for local Bun/Node execution. In serverless mode, `app` is returned unlistened.

---

## 3. Active Endpoints Exhaustive Reference

The following table comprehensively documents every active, mounted endpoint in the server:

| Method | Route Path | Auth Requirement | Elysia Validation Schema | Request Body / Query Params | Response Structure | Source Handler File | Implementation Notes & Lifecycle |
|---|---|---|---|---|---|---|---|
| **GET** | `/` | None | None | None | HTML (Scalar API UI) | `src/app.ts` | Serves OpenAPI specification rendered via Scalar CDN |
| **GET** | `/v1/healthz` | None | `response: t.String()` | None | `"OK"` (text/plain) | `src/endpoints/healthz.ts` | Fast liveness probe. Constant time string return |
| **GET** | `/v1/heartbeat` | None | `response: t.Object(...)` | None | `{ status, timestamp, uptimeMs, uptimeSec, processUptimeSec, node, region, env, deploymentUrl, commitSha }` | `src/endpoints/healthz.ts` | Uptime checker monitoring endpoint. `uptimeMs` measures current lambda instance life |
| **POST** | `/v1/youtube/auth/create` | None | `body: t.Object({ clientId, clientSecret, redirectUri })` | JSON Body: Google OAuth Client ID, Secret, Redirect URI | `{ success: true, message: string, data: { url: string } }` | `src/endpoints/v1/youtube/auth-create.ts` | Generates OAuth2 consent URL with scope `youtube.force-ssl`. Serializes client credentials as base64 JSON in the `state` parameter |
| **GET** | `/v1/youtube/auth/confirm` | None (Callback) | `query: t.Object({ code, state })` | Query: `code` (auth code), `state` (base64 JSON credentials) | `200`: `{ success: true, message: string, data: { accessToken, refreshToken, expiryDate } }`<br>`400`: `{ success: false, message: string }` | `src/endpoints/v1/youtube/auth-create.ts` | Decodes credentials from `state`, exchanges `code` via `oauth2Client.getToken(code)`, returns tokens to caller |
| **POST** | `/v1/youtube/channel/info` | None (Token in body) | `body: t.Object({ accessToken, maxResults?, pageToken? })` | JSON Body: `accessToken`, `maxResults` (0-50, default 5), `pageToken` | `200`: `{ success, message, data: { items, nextPageToken, pageInfo } }`<br>`400`: `{ success, message }` | `src/endpoints/v1/youtube/channel-info.ts` | Calls `youtube.channels.list({ mine: true, part: ['snippet', 'contentDetails', 'statistics'] })` |
| **POST** | `/v1/youtube/video/list` | None (Token in body) | `body: t.Object({ handle, accessToken, maxResults?, pageToken? })` | JSON Body: `handle` (@channel), `accessToken`, `maxResults` (default 50), `pageToken` | `200`: `{ success, message, data: { items, nextPageToken, pageInfo } }`<br>`400`: `{ success, message }` | `src/endpoints/v1/youtube/video-list.ts` | Two-step lookup: 1) fetches upload playlist ID via `forUsername: handle`, 2) calls `playlistItems.list` |
| **POST** | `/v1/youtube/comment/list` | None (Token in body) | `body: t.Object({ videoId, accessToken, maxResults?, pageToken?, textFormat?, order? })` | JSON Body: `videoId`, `accessToken`, `maxResults` (1-100, default 20), `pageToken`, `textFormat` ("html"\|"plainText"), `order` ("time"\|"relevance") | `200`: `{ success, message, data: { items, nextPageToken, pageInfo } }`<br>`400`: `{ success, message }` | `src/endpoints/v1/youtube/comment-lists.ts` | Calls `youtube.commentThreads.list({ videoId, part: ['snippet', 'replies'] })` |
| **POST** | `/v1/youtube/comment` | None (Token in body) | `body: t.Object({ accessToken, videoId, commentText })` | JSON Body: `accessToken`, `videoId` (1-100 chars), `commentText` (1-10000 chars) | `200`: `{ success, message, data: { id, snippet: { videoId, topLevelComment } } }`<br>`400`/`401`: `{ success, message }` | `src/endpoints/v1/youtube/comment-add.ts` | Inserts top-level comment via `youtube.commentThreads.insert` |
| **POST** | `/v1/youtube/comment/delete` | None (Token in body) | `body: t.Object({ commentId, accessToken })` | JSON Body: `commentId`, `accessToken` | `200`: `{ success, message }`<br>`400`/`401`: `{ success, message }` | `src/endpoints/v1/youtube/comment-delete.ts` | Deletes comment or reply by ID via `youtube.comments.delete` |
| **POST** | `/v1/youtube/reply/list` | None (Token in body) | `body: t.Object({ parentId, accessToken, maxResults? })` | JSON Body: `parentId` (comment ID), `accessToken`, `maxResults` (1-100, default 20) | `200`: `{ success, message, data: { items, pageInfo, nextPageToken, prevPageToken } }`<br>`400`: `{ success, message }` | `src/endpoints/v1/youtube/reply-list.ts` | Calls `youtube.comments.list({ parentId, part: ['snippet'] })` |
| **POST** | `/v1/youtube/reply` | None (Token in body) | `body: t.Object({ parentId, text, accessToken })` | JSON Body: `parentId`, `text` (1-10000 chars), `accessToken` | `200`: `{ success, message, data: { comment } }`<br>`400`: `{ success, message }` | `src/endpoints/v1/youtube/reply-add.ts` | Inserts reply under parent comment via `youtube.comments.insert` |
| **POST** | `/v2/widget/view` | None | `body: t.Object({ widgetId?, threadId? })` | JSON Body: optional `widgetId`, `threadId` | `{ success: true, thread_id, remain_limit: 999, messages: [...], widget: { ...persona } }` | `src/endpoints/v2/widget-endpoints.ts` | Restores conversation history for widget mount. Validates `threadId` or creates new one; retrieves persona from `widget_master` |
| **POST** | `/v2/widget/create-thread` | None | `body: t.Optional(t.Object({ widgetId? }))` | JSON Body: optional `widgetId` | `{ success: true, threadId, thread_id }` | `src/endpoints/v2/widget-endpoints.ts` | Allocates new UUID thread in `chat_thread` Supabase table |
| **POST** | `/v2/ask` | Widget Whitelist (`widget_master`) | `body: t.Object({ widgetId?, threadId?, message, browserInfo?, search? })` | JSON Body: `message` (required, max 4000 chars), `widgetId` (must exist in DB), optional `threadId` | `ReadableStream` (`text/event-stream`) streaming tokens as `data: <percent-encoded>\n\n`, ending in `data: [DONE]\n\n` | `src/endpoints/v2/widget-endpoints.ts` | SSE chat completion. Persists user prompt first, resolves system prompt hierarchy + RAG, streams tokens via `lib/llm`, persists assistant reply on close |
| **POST** | `/v2/admin/widgets` | `x-admin-token` = `ADMIN_TOKEN` | Detail only | None | `{ success: true, widgets: Array<WidgetOverview> }` | `src/endpoints/v2/widget-endpoints.ts` | Merges registered widgets from `widget_master` and active widgets from `chat_thread`, sorted by `latest_updated_at` |
| **POST** | `/v2/admin/widgets/upsert` | `x-admin-token` = `ADMIN_TOKEN` | `body: t.Object({ id, name?, theme?, description?, welcome_message?, system_prompt?, suggested_questions?, icon_url?, chat_bubble_size? })` | JSON Body: Widget configuration fields | `{ success: boolean, widget?: WidgetRow, error?: string }` | `src/endpoints/v2/widget-endpoints.ts` | Inserts or updates persona row in `widget_master` Supabase table |
| **POST** | `/v2/admin/widgets/delete` | `x-admin-token` = `ADMIN_TOKEN` | `body: t.Object({ id })` | JSON Body: `{ id: string }` | `{ success: boolean }` | `src/endpoints/v2/widget-endpoints.ts` | Soft-deletes widget by setting `deleted_at = now()` in `widget_master` |
| **POST** | `/v2/admin/widgets/upload-icon` | `x-admin-token` = `ADMIN_TOKEN` | `body: t.Object({ widgetId, file: t.File({ type: 'image' }) })` | Multipart/Form-Data: `widgetId`, image `file` (max 2 MiB) | `{ success: true, icon_url: string, path: string }` | `src/endpoints/v2/widget-endpoints.ts` | Uploads image to Supabase Storage bucket `widget-icons` bypassing RLS using service key, returns public URL |
| **POST** | `/v2/admin/threads` | `x-admin-token` = `ADMIN_TOKEN` | `body: t.Object({ widgetId? })` | JSON Body: `{ widgetId?: string }` | `{ success: true, threads: Array<ThreadSummary> }` | `src/endpoints/v2/widget-endpoints.ts` | Lists chat sessions for a widget with message counts, titles, prompt override flags, and timestamps |
| **POST** | `/v2/admin/threads/rename` | `x-admin-token` = `ADMIN_TOKEN` | `body: t.Object({ widgetId, threadId, title? })` | JSON Body: `widgetId`, `threadId`, `title` (or null/empty) | `{ success: boolean }` | `src/endpoints/v2/widget-endpoints.ts` | Sets or clears human-readable title in `chat_thread`. Scoped to `widgetId` to prevent cross-tenant modifications |
| **POST** | `/v2/admin/threads/update` | `x-admin-token` = `ADMIN_TOKEN` | `body: t.Object({ widgetId, threadId, system_prompt?, context_text? })` | JSON Body: `widgetId`, `threadId`, `system_prompt`, `context_text` | `{ success: boolean }` | `src/endpoints/v2/widget-endpoints.ts` | Configures per-session custom prompt or RAG reference context text on `chat_thread` |
| **POST** | `/v2/admin/messages` | `x-admin-token` = `ADMIN_TOKEN` | `body: t.Object({ widgetId?, threadId? })` | JSON Body: `widgetId`, `threadId` | `{ success: true, thread, messages: Array<{ role, content, created_at }> }` | `src/endpoints/v2/widget-endpoints.ts` | Fetches full conversation history up to 500 messages for an individual session |
| **POST** | `/v2/admin/db/migrate` | `x-admin-token` = `ADMIN_TOKEN` | `body: t.Optional(t.Object({ dryRun? }))` | JSON Body: optional `{ dryRun: boolean }` | `{ success, ran: Array<{ name, ok, error }>, remaining, totalPending }` | `src/endpoints/v2/widget-endpoints.ts` | Self-serve migration runner: checks `_migration_history`, executes pending `supabase/migrations/*.sql` via `admin_exec_sql` RPC |
| **POST** | `/v2/admin/mail/send` | `x-admin-token` = `MAIL_SEND_TOKEN` or `ADMIN_TOKEN` | `body: t.Object({ to, subject, text?, html?, from? })` | JSON Body: `to`, `subject`, `text` or `html` (one required), optional `from` | `{ success: boolean, messageId?: string, accepted?: string[], rejected?: string[], error?: string }` | `src/endpoints/v2/mail-endpoints.ts` | Dispatches email via Naver SMTP (`smtp.naver.com`). Fail-closed if neither token is configured (500) |
| **POST** | `/v2/admin/sms/send` | `x-admin-token` = `ADMIN_TOKEN` | `body: t.Object({ to, text })` | JSON Body: `to` (phone number), `text` (message) | `{ success: boolean, ...providerDetails }` | `src/endpoints/v2/sms-endpoints.ts` | Dispatches single SMS via backend selected by `SMS_PROVIDER` env (`phone`, `solapi`, `pushbullet`). *Note: defined in source but pending production rebundle* |

---

## 4. Deep-Dive: `/v2/ask` SSE Streaming Lifecycle & LLM Orchestration

`/v2/ask` is the primary real-time inference endpoint powering the chat widget. It implements an asynchronous streaming Server-Sent Events (SSE) pipeline with persistent turn storage and graceful fallback mechanisms.

```
Client POST /v2/ask { widgetId, threadId, message }
        │
        ├── [Guard 1] message.length > 4000 ? ──► 413 Payload Too Large
        │
        ├── [Guard 2] widgetMaster in widget_master ? ──► No: 403 Forbidden
        │
        ├── [Thread Resolution] Verify thread belongs to widgetId, or createThread()
        │
        ├── [User Turn Persistence] appendMessage(threadId, "user", message)
        │
        ├── [History Loading] listMessages(threadId)
        │
        ├── [Header Configuration]
        │     Content-Type: text/event-stream
        │     Cache-Control: no-cache, no-transform
        │     Connection: keep-alive
        │
        ▼ Return new Response(stream: ReadableStream)
┌────────────────────────────────────────────────────────────────────────┐
│ Stream Controller Execution:                                           │
│                                                                        │
│ 1. LLM Provider Instantiation (lib/llm):                               │
│    - Reads LLM_PROVIDER (openrouter, openai, groq, etc.) & LLM_API_KEY │
│    - If error during creation -> emits [LLM 설정 오류], [DONE], close  │
│                                                                        │
│ 2. System Prompt Hierarchy Resolution:                                 │
│    Priority 1: threadRow.system_prompt (session tuning)                │
│    Priority 2: widgetMaster.system_prompt (widget persona)             │
│    Priority 3: process.env.LLM_SYSTEM_PROMPT                           │
│    Priority 4: Built-in default ("You are a helpful assistant...")    │
│                                                                        │
│ 3. RAG Context Injection:                                              │
│    - If threadRow.context_text present:                                │
│      Injected as 2nd system message with explicit grounding directive  │
│                                                                        │
│ 4. Message Assembly:                                                   │
│    [System Prompt, (Optional RAG Prompt), ...Historical Messages]      │
│                                                                        │
│ 5. Token Generation & Streaming:                                       │
│    - Provider.stream(): AsyncIterable<string>                          │
│    - Each token accumulated in `assistantBuffer`                       │
│    - Token encoded with sendChunk():                                   │
│      '%'  -> '%25'                                                     │
│      ' '  -> '%20'                                                     │
│      '\n' -> '%0a'                                                     │
│      '\r' -> '%0d'                                                     │
│      Enqueues: `data: ${safe}\n\n`                                     │
│    - (If provider is null, fallback pickReply() simulated streaming)   │
│                                                                        │
│ 6. Error Trapping:                                                     │
│    - If generator throws -> emits `\n[LLM error] ${msg}`               │
│                                                                        │
│ 7. Finally Block:                                                      │
│    - If assistantBuffer has text -> appendMessage(threadId, "assistant"│
│    - Enqueues `data: [DONE]\n\n`                                       │
│    - controller.close()                                                │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Technical Details of `/v2/ask`:

1. **Defensive Persistence Ordering**:
   The user message is saved to PostgreSQL (`appendMessage`) **before** the stream opens. If the downstream LLM provider suffers a timeout, out-of-quota error, or crash, the user's prompt is not lost and remains in conversation history for subsequent queries.
2. **Specialized SSE Framing & Escaping**:
   SSE protocol defines newlines (`\n\n`) as event delimiters, and many client parsers trim leading spaces following `data: `. To prevent model-generated newlines from corrupting the stream boundary and preserve whitespace indentation, the server percent-encodes `%`, ` `, `\n`, and `\r`. Crucially, `%` is escaped first (`%` -> `%25`) to prevent malformed URI decoding exceptions (`URIError`) when model outputs contain literal percent symbols (e.g. `"100%"`).
3. **Hard Token Ceiling in OpenAI Compatible Client**:
   In `lib/llm/openai-compatible.ts`, outgoing requests enforce `max_tokens: Math.min(req.maxTokens ?? 256, 256)`. This protects the application against unexpected token credit depletion on free-tier providers (such as OpenRouter), guaranteeing compact answers.
4. **Resilient Assistant Turn Persistence**:
   In the `finally` block of the stream, `appendMessage(threadId, "assistant", assistantBuffer)` is attached with `.catch(e => console.error(...))`. This ensures that a transient database failure during assistant message insertion will never cause an unhandled rejection or interrupt the `controller.close()` termination of the client's HTTP stream.

---

## 5. Deep-Dive: YouTube OAuth Flow & Data Operations

### 5.1 Stateless OAuth Protocol Architecture

Unlike typical OAuth implementations that store temporary authorization state in server-side session cookies or Redis, `my-server-test` operates as a **fully stateless OAuth proxy**:

1. **Authorization Request (`POST /v1/youtube/auth/create`)**:
   - The client application submits its own Google Cloud credentials: `{ clientId, clientSecret, redirectUri }`.
   - The server creates a `google.auth.OAuth2` client.
   - It serializes `{ clientId, clientSecret, redirectUri }` into JSON and Base64-encodes it into the OAuth `state` parameter:
     ```ts
     const state = Buffer.from(JSON.stringify({ clientId, clientSecret, redirectUri })).toString("base64");
     ```
   - Returns the Google OAuth consent URL configured with `access_type: "offline"` and scope `https://www.googleapis.com/auth/youtube.force-ssl`.
2. **Authorization Callback (`GET /v1/youtube/auth/confirm`)**:
   - Google redirects the user back to the endpoint with `?code=...&state=...`.
   - The server Base64-decodes the `state` parameter back into the original `{ clientId, clientSecret, redirectUri }`.
   - Re-instantiates `google.auth.OAuth2` with those exact parameters and calls `oauth2Client.getToken(code)`.
   - Returns `{ accessToken, refreshToken, expiryDate }` to the client.

### 5.2 Client-Held Access Token Pattern

All subsequent YouTube API calls (`/v1/youtube/channel/info`, `/video/list`, `/comment/list`, `/comment`, `/comment/delete`, `/reply/list`, `/reply`) require the client to supply `accessToken` in the JSON request body.
The server:
1. Instantiates `const oauth2Client = new google.auth.OAuth2()`.
2. Sets credentials: `oauth2Client.setCredentials({ access_token: accessToken })`.
3. Dispatches the command directly to `google.youtube({ version: "v3", auth: oauth2Client })`.

### 5.3 Architectural & Validation Caveats in YouTube Endpoints

During exhaustive inspection, several critical schema validation discrepancies were discovered across the YouTube handlers:
- **Missing `set.status = 400` on Catches**:
  In `/v1/youtube/channel/info`, `/video/list`, `/comment/list`, `/comment`, `/comment/delete`, `/reply/list`, and `/reply`, the catch blocks return `{ success: false, message: ... }` but omit setting `set.status = 400`. Because Elysia defaults unassigned statuses to HTTP 200, Elysia's schema validator evaluates the return against the **200 response schema**. Because the 200 schema mandates a `data` object, returning `{ success: false, message }` triggers an Elysia **422 Validation Error** rather than the intended error object. (Note: Only `/v1/youtube/auth/confirm` correctly sets `set.status = 400`).
- **Response Schema Mismatch in `/comment`**:
  In `comment-add.ts`, the handler returns `{ code: 200, success: true, ... }`, but the Elysia `response` schema does not define a `code` field.

---

## 6. Authentication Mechanisms & Security Architecture

### 6.1 Fail-Closed Security Design

The server strictly follows the **fail-closed security principle** across all protected administrative routes:

```ts
// widget-endpoints.ts requireAdmin()
const expected = process.env.ADMIN_TOKEN?.trim();
if (!expected) {
  if (set) set.status = 500;
  return { success: false, error: "ADMIN_TOKEN env var not set on server" };
}
const token = (headers?.["x-admin-token"] || "").trim();
if (token !== expected) {
  if (set) set.status = 401;
  return { success: false, error: "unauthorized" };
}
```

- If `ADMIN_TOKEN` is not defined in the server environment (or is empty), the endpoint **fails closed with HTTP 500** rather than failing open.
- If the `x-admin-token` header is absent or does not match `ADMIN_TOKEN`, it immediately halts with **HTTP 401 Unauthorized**.
- Protected endpoints:
  - `/v2/admin/widgets`
  - `/v2/admin/widgets/upsert`
  - `/v2/admin/widgets/delete`
  - `/v2/admin/widgets/upload-icon`
  - `/v2/admin/threads`
  - `/v2/admin/threads/rename`
  - `/v2/admin/threads/update`
  - `/v2/admin/messages`
  - `/v2/admin/db/migrate`
  - `/v2/admin/sms/send`

### 6.2 Dual-Secret Scoped Authentication (`/v2/admin/mail/send`)

To allow external scheduled routines (such as macOS cron scripts) to send transactional emails without granting full administrative powers over database migrations and tenant records, `src/endpoints/v2/mail-endpoints.ts` implements a dual-token fallback:

```ts
const mailToken = process.env.MAIL_SEND_TOKEN?.trim();
const adminToken = process.env.ADMIN_TOKEN?.trim();

if (!mailToken && !adminToken) {
  set.status = 500;
  return { success: false, error: "neither MAIL_SEND_TOKEN nor ADMIN_TOKEN is set on server" };
}

const token = (headers["x-admin-token"] || "").trim();
const authorized =
  (!!mailToken && token === mailToken) ||
  (!!adminToken && token === adminToken);

if (!authorized) {
  set.status = 401;
  return { success: false, error: "unauthorized" };
}
```

- Callers can authenticate with either `MAIL_SEND_TOKEN` (least-privilege, mail-only) or `ADMIN_TOKEN` (root administrative).
- If neither token is defined in server environment variables, it fails closed (HTTP 500).

### 6.3 Public Surface Protection (Tenant Whitelisting)

The conversational inference route `/v2/ask` has no token-based authentication header because it is called by embeddable widgets loaded on third-party user websites. To prevent unmetered LLM token consumption by arbitrary attackers:
1. **Length Cap**: Any payload exceeding 4,000 characters is rejected with **HTTP 413**.
2. **Database Whitelist**: The route performs `getWidget(widgetId)` against `widget_master`. If `widgetId` is omitted or does not correspond to an active registered tenant in Supabase, the request is immediately rejected with **HTTP 403 Forbidden**.

---

## 7. Inactive & Unmounted Endpoints Catalog

In `src/endpoints/v1/v1-endpoints.ts`, only `v1Youtube(app)` is registered. The remaining **21 modules (120+ TypeScript files)** in `src/endpoints/v1/` are unmounted and dormant.

### Catalog of Inactive Modules:

| Module Directory | Representative Files & Endpoints | Purpose & Functionality | Why It Is Inactive / Unmounted |
|---|---|---|---|
| `account/` | `otp-sms.ts`, `otp-check.ts`, `login-check.ts`, `logout.ts`, `get-user-profile.ts`, `update-user-profile.ts` (`POST/GET /v1/account/*`) | User authentication via phone SMS OTP, JWT cookie issuance, user profile CRUD | Requires legacy `user` table in Supabase (not present in current migrations) and `JWT_SECRET_KEY` |
| `api-key/` | `create.ts`, `list.ts`, `delete.ts`, `update.ts` (`POST /v1/api-key/*`) | Workspace developer API key issuance and management | Belongs to retired workspace multi-tenant SaaS model |
| `authorized/` | `authorized-message.ts`, `send-message.ts` (`POST /v1/authorized/*`) | Authenticated bot message dispatching | Coupled to unmounted workspace and user tables |
| `billing/` | `card/*`, `product/*`, `subscription/*` (`POST/PATCH/DELETE /v1/billing/*`) | Toss Payments billing card registration, subscription plan selection, automated recurring billing | Coupled to external Toss Payments billing gateway and missing billing database tables |
| `botstore/` | `approval-request.ts`, `check-approval.ts`, `list.ts` (`POST /v1/botstore/*`) | Public store for sharing and approving conversational bot templates | Unused feature; requires approval workflow tables |
| `chat/` | `overview.ts`, `set-default-workspace.ts` (`POST /v1/chat/*`) | Legacy chat usage stats and workspace assignment | Superseded by `/v2/*` chat widget architecture |
| `crawl/` | `page-rank.ts` (`POST /v1/crawl/page-rank`) | Web scraping and PageRank calculation | High resource utilization; incompatible with serverless cold starts |
| `default-workspace/` | `assign.ts`, `delete.ts`, `view.ts` (`POST /v1/default-workspace/*`) | Managing active default workspace context for multi-tenant users | Legacy SaaS workspace concept retired |
| `kakao/` | `chatbot-connect.ts`, `kakao-widget-connect.ts` (`POST /v1/kakao/*`) | Kakao i Open Builder chatbot skill payload adapter and Kakao Talk channel linking | Dependent on Kakao business channel credentials and retired data schemas |
| `link/` | `aiqr.ts`, `chat-script.ts`, `delete.ts` (`POST /v1/link/*`) | Generating AI-decorated QR codes and HTML `<script>` embed tags | Replaced by v2 embed scripts and playground tools |
| `llamiwiki/` | `sign-in.ts` (`POST /v1/llamiwiki/sign-in`) | Internal documentation wiki SSO login integration | Internal corporate tooling; not part of public API |
| `notice/` | `notice-list.ts` (`POST /v1/notice/list`) | System announcements and platform notices | Requires `notice` table in database |
| `office/` | `send-sms.ts`, `upload-image.ts`, `user-token.ts` (`POST /v1/office/*`) | Internal back-office administration utilities (SMS, images, tokens) | Superseded by `/v2/admin/*` routes |
| `oneoff/` | `payment/card.ts` (`POST /v1/oneoff/payment/card`) | Single one-time credit card checkout via Toss Payments | Replaced by direct subscription / invoice workflows |
| `payment/` | `deposit-view.ts`, `deposit-workspace.ts`, `toss-callback.ts`, `add-special-limit.ts` (`POST /v1/payment/*`) | Toss Payments webhooks, virtual bank account deposits, manual limit top-ups | Coupled to retired Toss payment infrastructure |
| `realtime/` | `ws.ts` (`WS /v1/realtime`) | WebSocket real-time chat gateway | **Architectural mismatch**: Elysia `app.group` has documented bugs with WebSockets, and Vercel Node Serverless Functions cannot maintain persistent WebSockets |
| `scrap/` | `google-search.ts`, `naver-search.ts`, `coupang-search.ts` (`POST /v1/scrap/*`) | SERP scraping (Google, Naver, Coupang) using `@llami/gpt-torch`, residential proxies, and Voyage AI vector embeddings | Heavy external dependencies, residential proxy requirements, and significant latency unsuitable for serverless |
| `social/` | `instagram/oauth.ts`, `instagram/webhook.ts`, `instagram/apply-widget.ts` (`GET/POST /v1/social/instagram/*`) | Meta Instagram Graph API webhooks and automated DM reply bot | Requires Meta Developer App verification, long-lived access tokens, and webhook secrets |
| `vector/` | `query.ts` (`POST /v1/vector/query`) | Vector similarity query over document embeddings | Replaced by RAG session injection (`context_text`) in v2 |
| `widget/` (v1) | 25 files: `overview.ts`, `list.ts`, `update.ts`, `delete.ts`, `transfer.ts`, `thread-*`, `file-upload.ts`, etc. (`POST /v1/widget/*`) | Complete legacy v1 widget backend with file uploads, contacts, and analytics | **Superseded by `/v2/widget/*` and `/v2/admin/*`**. Entirely rewritten for cleaner schema and lazy proxy Supabase client |
| `workspace/` | 14 files: `list.ts`, `view.ts`, `update.ts`, `delete.ts`, `member-*`, `limit-*`, `succession.ts` (`POST /v1/workspace/*`) | Full multi-tenant workspace administration (member invites, role assignments, quota prechecks) | Retired organizational model |

### Reasons for Inactivity and Hazards of Re-Mounting:
1. **Schema Mismatch**: The current Supabase database schema only contains migrations for `chat_thread`, `chat_message`, and `widget_master`. Re-mounting v1 modules would cause runtime crashes whenever database queries target missing tables (`user`, `workspace`, `billing_card`, etc.).
2. **Serverless Function Size & Cold Starts**: Bundling all 129 files into `api/index.js` would dramatically expand the bundle beyond its current 27MB, increasing AWS Lambda/Vercel initialization latency and risking bundle memory constraints.
3. **Missing Environment Variables**: Many v1 modules unconditionally read variables such as `JWT_SECRET_KEY`, `VOYAGE_API_KEY`, `TOSS_SECRET_KEY`, and proxy credentials.
4. **Vercel Serverless Lifecycle Limits**: Long-running operations like SERP crawling (`src/endpoints/v1/scrap`) and persistent WebSockets (`src/endpoints/v1/realtime`) violate serverless execution time limits (10-15s) and connection termination models.

---

## 8. Key Findings, Technical Debt & Refactoring Recommendations

1. **Error Status Codes in YouTube Handlers**:
   In `src/endpoints/v1/youtube/` (`channel-info.ts`, `video-list.ts`, `comment-lists.ts`, `comment-add.ts`, `comment-delete.ts`, `reply-list.ts`, `reply-add.ts`), error handlers return `{ success: false, message }` without setting `set.status = 400`. Because the 200 response schema requires `data`, this triggers a confusing Elysia 422 validation failure. Adding `set.status = 400` across all catch blocks will resolve this.
2. **Production Bundle Discrepancy for SMS Endpoint**:
   `src/endpoints/v2/sms-endpoints.ts` is mounted in TypeScript (`src/app.ts`), but `api/index.js` in the repository has not been rebuilt since the SMS route was added. Consequently, `/v2/admin/sms/send` functions in local development (`bun run dev`) but returns 404 in production on Vercel.
3. **Dead Code Elimination**:
   The 21 unmounted directories in `src/endpoints/v1/` contain 120+ unreferenced files that add cognitive overhead, confuse type checkers, and necessitate `@ts-ignore` suppressions in `src/app.ts` and `v1-endpoints.ts`. Archiving or removing them will substantially streamline the codebase.
4. **Response Schema Cleanliness in `comment-add.ts`**:
   The handler returns an undeclared property `code: 200` or `code: 400`. This should either be added to the Elysia schema or omitted to align with the rest of the YouTube API design.

---
*Report compiled autonomously by Explorer 2. No source code modifications were made.*
