# Handoff Report: Endpoints, Routing, and Lifecycle Architecture

**Agent**: Explorer 2  
**Working Directory**: `/Users/user/src/my-server-test/.agents/explorer_2`  
**Date**: 2026-09-17  
**Type**: Hard Handoff (Task Complete)

---

## 1. Observation

Direct code observations from `/Users/user/src/my-server-test`:

1. **Routing Assembly (`src/app.ts:1-66`)**:
   - `createApp` registers: CORS preflight hook (`onAfterHandle`), `cors({ origin: true })`, `swagger({ path: "/" })`, `v1Endpoints(app)`, `v2WidgetEndpoints(app)`, `v2MailEndpoints(app)`, `v2SmsEndpoints(app)`, and `healthzEndpoint(app)`.
   - All router invocations use `// @ts-ignore` to suppress compilation errors.
2. **Healthz (`src/endpoints/healthz.ts:7-67`)**:
   - `GET /v1/healthz` returns plain string `"OK"`.
   - `GET /v1/heartbeat` returns JSON with `status`, `timestamp`, `uptimeMs`, `uptimeSec`, `processUptimeSec`, `node`, `region`, `env`, `deploymentUrl`, `commitSha`.
3. **Mounted vs Unmounted v1 Endpoints (`src/endpoints/v1/v1-endpoints.ts:5-12`)**:
   - Only `v1Youtube(app)` is registered under `/v1`.
   - 21 directory trees are unmounted: `account/`, `api-key/`, `authorized/`, `billing/`, `botstore/`, `chat/`, `crawl/`, `default-workspace/`, `kakao/`, `link/`, `llamiwiki/`, `notice/`, `office/`, `oneoff/`, `payment/`, `realtime/`, `scrap/`, `social/`, `vector/`, `widget/`, and `workspace/` (totaling 120+ unreferenced `.ts` files).
4. **Active YouTube Endpoints (`src/endpoints/v1/youtube/index.ts:1-38`)**:
   - 8 handlers mounted under `/v1/youtube`: `POST /auth/create`, `GET /auth/confirm`, `POST /channel/info`, `POST /video/list`, `POST /comment/list`, `POST /comment`, `POST /comment/delete`, `POST /reply/list`, `POST /reply`.
   - Stateless OAuth: `/auth/create` Base64-encodes `{ clientId, clientSecret, redirectUri }` directly into the Google OAuth `state` parameter (`auth-create.ts:18-24`); `/auth/confirm` unpacks `state` and calls `oauth2Client.getToken(code)`.
   - Pass-through token: all remaining endpoints expect `accessToken` in the request body; none persist tokens in Supabase.
   - Status code issue: All catch blocks (except `/auth/confirm`) omit `set.status = 400`, which causes Elysia schema validation to test error objects against the 200 response schema and return 422.
5. **Active v2 Endpoints (`src/endpoints/v2/`)**:
   - `widget-endpoints.ts`:
     - Public: `POST /v2/widget/view`, `POST /v2/widget/create-thread`, `POST /v2/ask`.
     - Admin: `POST /v2/admin/widgets`, `/widgets/upsert`, `/widgets/delete`, `/widgets/upload-icon`, `/threads`, `/threads/rename`, `/threads/update`, `/messages`, `/db/migrate`.
   - `mail-endpoints.ts`: `POST /v2/admin/mail/send`.
   - `sms-endpoints.ts`: `POST /v2/admin/sms/send`.
6. **`/v2/ask` SSE Lifecycle (`widget-endpoints.ts:146-330`)**:
   - Guard 1: `userMessage.length > 4000` -> 413.
   - Guard 2: `widgetId` must exist in `widget_master` table -> 403.
   - User message persisted via `appendMessage(threadId, "user", message)` *before* stream creation.
   - Stream returns `text/event-stream` with percent-encoded tokens (`%` -> `%25`, space -> `%20`, `\n` -> `%0a`, `\r` -> `%0d`).
   - Multi-tier system prompt hierarchy: `threadRow.system_prompt` > `widgetMaster.system_prompt` > `process.env.LLM_SYSTEM_PROMPT` > default.
   - Optional RAG reference context: `threadRow.context_text` injected as 2nd system message.
   - Assistant turn persisted via `appendMessage(threadId, "assistant", assistantBuffer)` in stream `finally` block before closing with `data: [DONE]\n\n`.
7. **Authentication Mechanisms**:
   - `requireAdmin(headers, set)`: validates `headers["x-admin-token"] === process.env.ADMIN_TOKEN`. Fail-closed (returns 500 if `ADMIN_TOKEN` is unset; returns 401 if token mismatch).
   - `/v2/admin/mail/send`: accepts `MAIL_SEND_TOKEN` or `ADMIN_TOKEN`. Fail-closed (500) if neither is set.
8. **Serverless Adapter (`lambda-src/handler.ts`)**:
   - Node `IncomingMessage` converted to Web `Request` via `toWebRequest()`.
   - Handled via `app.handle(webReq)`.
   - Web `Response` piped to Node `ServerResponse` via `res.write()` reading from `webRes.body.getReader()`, enabling SSE streaming on Vercel Node serverless.

---

## 2. Logic Chain

1. **Premise**: `my-server-test` operates as a production serverless REST API on Vercel (`https://my-server-test.vercel.app/`).
2. **Routing Flow**: `lambda-src/handler.ts` serves as the entry point, converting Node requests to standard Web `Request`s and passing them into Elysia's `app.handle()`.
3. **Endpoint Partitioning**:
   - In `src/app.ts`, `v1Endpoints(app)` only exposes YouTube routes. The remaining 21 legacy directories in `src/endpoints/v1/` are excluded from the route tree.
   - Verification of Supabase migrations confirms the database only contains schemas for `chat_thread`, `chat_message`, and `widget_master`. Thus, legacy v1 routes referencing `user`, `workspace`, or `billing_card` would crash if invoked.
   - Modern chat functionality and administration are isolated entirely in `src/endpoints/v2/`.
4. **Security Analysis**:
   - Administrative endpoints strictly enforce `x-admin-token` with fail-closed behavior: if the environment variable is missing, requests return 500; if mismatched, 401.
   - Public chat completion (`/v2/ask`) avoids open-relay LLM token abuse by verifying tenant registration in `widget_master` (HTTP 403 on unregistered IDs).
5. **Streaming Reliability**:
   - Percent-encoding token streams prevents SSE delimiter collisions (`\n\n`) and preserves whitespace.
   - Pre-persisting user turns guarantees conversation continuity even if downstream LLM providers crash or timeout.
   - Assistant message persistence in `finally` guarantees that partial or completed replies are stored without blocking the stream's close frame (`[DONE]`).

---

## 3. Caveats

1. **Unbundled SMS Route in Production**: Although `src/endpoints/v2/sms-endpoints.ts` is registered in `src/app.ts`, `api/index.js` in the repository was built before that commit; therefore, `/v2/admin/sms/send` works in local development (`bun run dev`) but returns 404 in production until `api/index.js` is rebundled and deployed.
2. **YouTube 422 vs 400 Invalidation**: Due to missing `set.status = 400` in YouTube catch blocks, client error tests expecting HTTP 400 will receive HTTP 422 unless status codes are explicitly set.
3. **Hard Ceiling on Model Tokens**: `lib/llm/openai-compatible.ts` enforces `Math.min(req.maxTokens ?? 256, 256)`, capping all replies to 256 tokens regardless of `LLM_MAX_TOKENS` settings.

---

## 4. Conclusion

- The active API surface is strictly bounded to 2 healthz routes, 8 YouTube proxy routes, 3 public v2 widget routes, and 11 administrative v2 routes.
- The 21 dormant v1 modules represent historical technical debt from a monolithic SaaS architecture and should be archived to eliminate dead code and restore clean TypeScript compilation without `@ts-ignore`.
- `/v2/ask` provides a robust, multi-tenant SSE streaming design with resilient two-turn database persistence and prompt hierarchy customization.
- Complete detailed analysis is documented in `/Users/user/src/my-server-test/.agents/explorer_2/report.md`.

---

## 5. Verification Method

To independently verify these findings:

1. **Examine Route Mounting**:
   - Inspect `src/app.ts` lines 48-59 to verify mounted route groups.
   - Inspect `src/endpoints/v1/v1-endpoints.ts` lines 5-12 to verify that only `v1Youtube` is registered.
2. **Verify Inactive Directories**:
   - Run `find src/endpoints/v1 -mindepth 1 -maxdepth 1 -type d` to observe the 21 unmounted subdirectories.
3. **Verify Fail-Closed Auth**:
   - Inspect `src/endpoints/v2/widget-endpoints.ts` lines 35-51 (`requireAdmin`).
   - Inspect `src/endpoints/v2/mail-endpoints.ts` lines 33-53 (`v2MailEndpoints`).
4. **Verify `/v2/ask` Streaming & Guards**:
   - Inspect `src/endpoints/v2/widget-endpoints.ts` lines 146-330.
5. **Verify YouTube Error Status Omission**:
   - Inspect `src/endpoints/v1/youtube/comment-lists.ts` line 64 and `video-list.ts` line 57.
