# Exhaustive Architectural & Subsystem Analysis Report (`my-server-test`)

**Explorer**: Explorer 3  
**Date**: 2026-09-17 (UTC 2026-09-17T11:25:30Z)  
**Target Codebase**: `/Users/user/src/my-server-test`  
**Focus**: Utilities, Stores, Subsystem Engines, Standalone Scripts, Database Migrations, and Architectural Patterns

---

## Executive Summary

`my-server-test` is an Elysia-based TypeScript API server adapted to run inside Vercel's Node.js 20.x serverless environment via a custom single CommonJS bundle (`api/index.js`).

This investigation covered the complete storage, AI/LLM, messaging, database, script, and utility architecture of the application. The primary findings include:
1. **Supabase Lazy Proxy Pattern (`lib/supabase/client.ts`)**: A crucial architectural safety mechanism using ES6 `Proxy` and memoization to defer client instantiation from module evaluation (cold start) until runtime property access. This prevents `FUNCTION_INVOCATION_FAILED` container crashes when database credentials are not configured or when unrelated endpoints (e.g. `/v1/healthz`, `/v1/youtube/*`) are invoked.
2. **Multi-Vendor LLM Streaming Engine (`lib/llm/`)**: A unified, vendor-agnostic interface (`LLMProvider`) supporting 8 presets (`openrouter`, `openai`, `groq`, `together`, `deepseek`, `mistral`, `fireworks`, and `custom`) via `OpenAICompatibleProvider`. It provides SSE chunk decoding, percent-encoding for transport stability, token limiting, prompt hierarchy resolution, and automated fallback to canned replies.
3. **Multi-Provider SMS Engine (`lib/sms/`)**: A zero-cost personal SMS subsystem supporting `phone` (Android SMS Gate HTTP gateway), `pushbullet` (Google Play Store app API), and `imessage` (macOS `osascript` + iPhone text forwarding), managed via `SMS_PROVIDER`. Solapi/CoolSMS was removed due to corporate billing/liability risks. It includes local usage quota tracking (`.sms-usage.json`) and post-send delivery verification against macOS `chat.db`.
4. **Persistence & Migration Pipeline**: Supabase PostgreSQL schemas (`chat_thread`, `chat_message`, `widget`, `_migration_history`) managed by a custom self-serve migration runner (`POST /v2/admin/db/migrate`) powered by inlined SQL in `src/generated-migrations.ts` via `scripts/build-migrations.mjs`.
5. **Operational Scripts (`scripts/`)**: A suite of robust CLI utilities including `send-greetings.ts` (safe batch SMS sender with dry-run default), `sms-verify.ts`, `sms-devices.ts`, and `upsert-widget.ts`.
6. **Critical Technical Debt & Vulnerabilities Identified**:
   - **Production Bundle Drift**: `api/index.js` was last built on 2026-08-19. Commits from 2026-09-15 and 2026-09-17 (`lib/sms/imessage.ts`, `imessage-verify.ts`, `pushbullet.ts`) are **not present** in the committed production bundle.
   - **Outdated Database Types**: `lib/supabase/database.types.ts` does not include `chat_thread`, `chat_message`, or `widget`, necessitating an untyped escape hatch (`supabaseUntyped`) and preventing strict compilation.
   - **Unmounted Legacy Code**: Inactive endpoints in `src/endpoints/v1/` reference deleted files (`@/lib/sms/solapi`), causing 1100+ TypeScript errors and necessitating `buildCommand: "echo skip"` in `vercel.json`.
   - **Module-Load Top-Level Instantiations**: Legacy utilities (`lib/storage/r2Client.ts`, `lib/jwt.ts`, `lib/ai/openai.ts`, `lib/api-key.ts`) still instantiate clients with non-null environment assertions at boot time.

---

## 1. Supabase Lazy Proxy Pattern (`lib/supabase/client.ts`)

### 1.1 The Serverless Cold-Start Problem
In Vercel Node serverless function deployments, incoming HTTP requests are handled by booting a Node.js process and evaluating the bundled JavaScript file (`api/index.js`).
If a module performs top-level evaluation that throws an unhandled exception:
```typescript
// ANTI-PATTERN: Throws immediately when module is loaded if env is missing
export const supabaseClient = createSupabaseClient("public");
```
Any missing environment variable (`SUPABASE_URL` or `SUPABASE_SERVICE_KEY`) causes an uncaught error at module evaluation time. The Lambda container immediately terminates with `FUNCTION_INVOCATION_FAILED`. Consequently:
- Even endpoints that never touch Supabase (such as `GET /v1/healthz`, `GET /v1/heartbeat`, or YouTube OAuth endpoints) crash with HTTP 500.
- Vercel health checks and deployment sanity checks fail.
- Route-level `try/catch` error handling cannot catch the error because execution never reaches any request handler.

### 1.2 Technical Mechanics of the Lazy Proxy
In `lib/supabase/client.ts` (lines 25–35), this failure mode is solved using an ES6 `Proxy` combined with memoized singleton caching:

```typescript
// lib/supabase/client.ts:25-35
let _cachedClient: ReturnType<typeof createSupabaseClient<"public">> | null = null;
const getClient = () => {
  if (!_cachedClient) _cachedClient = createSupabaseClient<"public">("public");
  return _cachedClient;
};

export const supabaseClient = new Proxy({} as ReturnType<typeof createSupabaseClient<"public">>, {
  get(_target, prop) {
    return Reflect.get(getClient() as any, prop);
  },
});
```

#### How it works:
1. **Target Dummy**: The proxy wraps a benign empty object `{}` cast to the client type.
2. **Zero Evaluation at Boot**: During module loading and bundle evaluation, `supabaseClient` is simply an uninstantiated Proxy object. No network connection is made, and `createSupabaseClient` is not called.
3. **Property Access Trap (`get`)**: When code calls `supabaseClient.from("chat_thread")`, the `get` trap intercepts access to property `"from"`.
4. **Deferred Instantiation**: Inside the trap, `getClient()` is called. If `_cachedClient` is null, `createSupabaseClient<"public">("public")` executes.
5. **Runtime Error Boundary**: If `SUPABASE_URL` or `SUPABASE_SERVICE_KEY` is missing, `createSupabaseClient` throws at line 8 or 12. Crucially, this happens **inside the route handler** during active request processing, allowing route `try/catch` or Elysia's global error handler to catch the error and return a structured JSON response instead of crashing the serverless container.
6. **Singleton Reuse**: Once initialized, `_cachedClient` remains resident in memory for the life of that warm serverless container instance, avoiding redundant client creations.

### 1.3 The `supabaseUntyped` Escape Hatch
`lib/supabase/client.ts` (lines 39–53) defines:
```typescript
// lib/supabase/client.ts:52-53
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabaseUntyped = supabaseClient as unknown as { from: (table: string) => any };
```

#### Why it exists:
- `lib/supabase/database.types.ts` is generated from Supabase CLI introspection. It contains 2,788 lines of legacy schema definitions (`active_requests`, `llami_*`, etc.) from an older project, but lacks the modern tables (`chat_thread`, `chat_message`, `widget`, `_migration_history`).
- In `@supabase/supabase-js`, if a table name is not in the `Database` interface, TypeScript treats every chained method call (`.from().select().eq().order().limit()`) as a type error.
- Placing `@ts-expect-error` only suppresses the immediately following line, leaving dozens of chained call errors across `lib/chat-store.ts` and `lib/widget-store.ts` (over 60 errors).
- `supabaseUntyped` casts the exact same lazy proxy client to `{ from: (table: string) => any }`, restoring runtime behavior while silencing compile-time type mismatches until `database.types.ts` is re-introspected.

---

## 2. Multi-Vendor LLM Streaming Engine (`lib/llm/`)

The LLM subsystem provides a vendor-agnostic streaming interface powering `/v2/ask`.

### 2.1 Provider Abstraction & Contract
`lib/llm/types.ts` establishes a contract:
```typescript
export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface LLMStreamRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  readonly name: string;
  stream(req: LLMStreamRequest, signal?: AbortSignal): AsyncIterable<string>;
}
```
Any concrete vendor must implement `LLMProvider` returning an `AsyncIterable<string>` of token deltas.

### 2.2 Concrete Implementation: `OpenAICompatibleProvider`
`lib/llm/openai-compatible.ts` implements `LLMProvider` for any endpoint implementing the OpenAI Chat Completions API with Server-Sent Events (`stream: true`).

#### Streaming Token Mechanics:
1. **HTTP Dispatch**: Sends `POST ${this.baseUrl}/chat/completions` with `stream: true` and `Authorization: Bearer ${this.apiKey}`.
2. **Response Body Reader**: Acquires `reader = resp.body.getReader()` and streams byte chunks through `TextDecoder({ stream: true })`.
3. **SSE Line Buffering**: Accumulates byte decodings into `buffer`, splits on newline (`\n`), and extracts lines beginning with `data:`.
4. **Completion Handling**: When payload equals `[DONE]`, the generator terminates (`return`).
5. **Delta Extraction**: Parses JSON payloads `{"choices":[{"delta":{"content":"..."}}]}` and yields string tokens.
6. **Token Limiting**: Enforces `max_tokens: Math.min(req.maxTokens ?? 256, 256)` (line 61) to accommodate free OpenRouter credit restrictions.

### 2.3 Provider Presets & Factory (`lib/llm/factory.ts`)
`createLLMProvider()` reads environment variables:
- If `LLM_API_KEY` is not present, returns `null` (triggering fallback).
- Evaluates `LLM_PROVIDER` against built-in presets:

| Provider | Base URL | Default Model | Custom Headers |
|---|---|---|---|
| `openrouter` (default) | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` | `HTTP-Referer`, `X-Title` (traffic attribution) |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` | None |
| `groq` | `https://api.groq.com/openai/v1` | `llama-3.1-70b-versatile` | None |
| `together` | `https://api.together.xyz/v1` | `meta-llama/Llama-3.1-70B-Instruct-Turbo` | None |
| `deepseek` | `https://api.deepseek.com` | `deepseek-chat` | None |
| `mistral` | `https://api.mistral.ai/v1` | `mistral-small-latest` | None |
| `fireworks` | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/llama-v3p1-70b-instruct` | None |
| `custom` | `process.env.LLM_BASE_URL` | `gpt-4o-mini` (or `LLM_MODEL`) | None (Supports Ollama, vLLM, LM Studio) |

Overrides:
- `LLM_MODEL`: Overrides preset default model.
- `LLM_BASE_URL`: Overrides preset endpoint URL.

### 2.4 Streaming Protocol & Fallback in `/v2/ask`
In `src/endpoints/v2/widget-endpoints.ts` (lines 190–316):
1. **Fallback When Unconfigured**: If `createLLMProvider()` returns `null`, the endpoint uses `pickReply(userMessage)` and simulates streaming with chunked canned text and `await sleep(40)`.
2. **System Prompt Resolution Hierarchy**:
   ```
   threadRow.system_prompt (session override)
     -> widgetMaster.system_prompt (widget persona)
       -> process.env.LLM_SYSTEM_PROMPT
         -> Built-in default (1-2 sentences, Korean/user language)
   ```
3. **Session Grounding / RAG**: If `threadRow.context_text` exists, it is injected as a second system message instructing the model to treat it as authoritative session reference material.
4. **Transport Encoding**: Tokens are percent-encoded (`%` -> `%25`, space -> `%20`, `\n` -> `%0a`, `\r` -> `%0d`) before writing to `data: ${safe}\n\n`. This prevents raw newlines from prematurely triggering SSE event boundaries and prevents leading spaces from being trimmed by client parsers. Crucially, `%` is escaped first to avoid `URIError` during client-side `decodeURIComponent`.
5. **Turn Persistence**: When the stream finishes or errors, the `finally` block persists the assistant output to `chat_message` via `appendMessage(threadId, "assistant", assistantBuffer)`.

---

## 3. Multi-Provider SMS Engine (`lib/sms/`)

The SMS subsystem in `lib/sms/` is designed for zero-cost messaging without recurring gateway subscription fees.

### 3.1 Provider Switching via `SMS_PROVIDER`
`lib/sms/index.ts` exposes `sendSms({ phoneNumber, text })` and selects the backend via `activeProvider()`:

```typescript
export type SmsProvider = "phone" | "pushbullet" | "imessage";
```

| Provider | Mechanism | Cost & Quota | Platform Requirement | Setup Requirement |
|---|---|---|---|---|
| `phone` (default) | Android SMS Gate app (`sms-gate.app`) via LAN HTTP POST | 0 KRW; Unlimited (carrier plan) | Any server reaching phone LAN/IP | Android device with SMS Gate APK installed |
| `pushbullet` | Pushbullet API (`api.pushbullet.com/v2/texts`) | 0 KRW; ~100 texts/month free limit | Any server with internet access | Google Play Pushbullet app; Access Token |
| `imessage` | macOS `Messages.app` + iPhone Text Forwarding via `osascript` | 0 KRW; Unlimited (carrier plan) | **macOS local only** (`darwin`) | iPhone "Text Message Forwarding" enabled |

#### Removal of Solapi (CoolSMS):
`lib/sms/solapi.ts` was permanently removed in git commits `8dbd219` and `9f1987db` because the credentials belonged to an employer/company account, creating financial credit and legal liability risks. `activeProvider()` in `lib/sms/index.ts` line 29 explicitly catches `"solapi"` and any unrecognized values, falling back safely to `"phone"`.

### 3.2 Provider Mechanics

#### 1. Phone Gateway (`lib/sms/phone-gateway.ts`)
- Connects to an Android phone running SMS Gate in Local Server mode.
- Authenticates via HTTP Basic Auth (`SMS_GATEWAY_USERNAME` : `SMS_GATEWAY_PASSWORD`).
- Path Drift Handling: Tries `COMMON_PATHS = ["/message", "/3rdparty/v1/messages"]` sequentially to maintain compatibility across different SMS Gate app versions.
- Supports dual-SIM slot selection via `SMS_GATEWAY_SIM` (1 or 2).

#### 2. Pushbullet (`lib/sms/pushbullet.ts`)
- Queues an SMS on Pushbullet servers (`POST /v2/texts`) targeting an Android device.
- Device Resolution (`resolveDeviceIden`):
  - Uses `PUSHBULLET_DEVICE_IDEN` if set.
  - Otherwise, resolves `PUSHBULLET_DEVICE_NICKNAME` dynamically by querying `GET /v2/devices` and caches the matching device ID in `cachedIden`.
- Enforces monthly usage tracking via `lib/sms/usage.ts`.

#### 3. iMessage (`lib/sms/imessage.ts`)
- Spawns `osascript` with standard input script and passes parameters via command-line arguments:
  ```typescript
  const child = spawn("osascript", ["-", phoneNumber, text, serviceId]);
  ```
  Passing arguments via `argv` prevents AppleScript injection attacks from malicious names or message bodies.
- Enforces a timeout (`IMESSAGE_SEND_TIMEOUT_MS`, default 30,000ms).
- Returns `{ ok: true, status: 0, deliveryConfirmed: false }`: AppleScript only confirms receipt by Messages.app queue; delivery across cellular networks is asynchronous.
- Known limitation: Carrier SMS forwarding cannot deliver messages sent to the relay iPhone's own phone number.

### 3.3 Delivery Verification (`lib/sms/imessage-verify.ts`)
To detect silent iMessage delivery failures (red exclamation marks):
1. Reads macOS Messages SQLite database directly: `~/Library/Messages/chat.db` (or `IMESSAGE_DB_PATH`).
2. Calls macOS built-in `sqlite3 -readonly -json` CLI rather than compiling native C++ SQLite bindings.
3. Requires macOS **Full Disk Access** permission for the terminal process (`canReadMessagesDb()`).
4. Converts Apple epoch timestamps (offset 978,307,200 seconds from Unix epoch) and normalizes phone numbers (stripping `+82`, `82`, `0` prefixes).
5. Inspects `is_sent`, `is_delivered`, and `error` columns to classify status as `delivered`, `sent`, `failed`, `pending`, or `not_found`.

### 3.4 Usage Tracking (`lib/sms/usage.ts`)
- File Location: `.sms-usage.json` (git-ignored, customizable via `SMS_USAGE_FILE`).
- Schema: `{ "2026-09": { "pushbullet": 14, "phone": 0 } }`.
- Privacy: Stores strictly integer counters per month/provider; **no phone numbers or message texts** are recorded.
- Safe Operations: Read/write errors output warnings to `console.warn` without throwing, ensuring message dispatch is never blocked by a filesystem lock.

---

## 4. Persistence & Database Schema

All database interactions run against Supabase PostgreSQL via the service-role client.

### 4.1 Schema Evolution & Migration History

```
supabase/migrations/
├── 0000_00_00__migration_runner_bootstrap.sql
├── 2026_05_22__chat_history.sql
├── 2026_05_23__widget_master.sql
├── 2026_05_28__thread_title.sql
├── 2026_05_29__thread_prompt.sql
├── 2026_05_29__widget_bubble_size.sql
└── 2026_05_29__widget_icon.sql
```

#### Detailed Table Specifications:

| Table | Column | Type | Constraints / Defaults | Description |
|---|---|---|---|---|
| `public.chat_thread` | `id` | `uuid` | PK, `default gen_random_uuid()` | Thread session ID |
| | `widget_id` | `text` | NOT NULL | Associated widget identifier |
| | `is_deleted` | `boolean` | NOT NULL, `default false` | Soft-delete flag |
| | `created_at` | `timestamptz` | NOT NULL, `default now()` | Creation timestamp |
| | `updated_at` | `timestamptz` | NOT NULL, `default now()` | Auto-bumped on message insert |
| | `title` | `text` | NULLABLE | Human-readable session title (added in `2026_05_28`) |
| | `system_prompt` | `text` | NULLABLE | Session-level system prompt override (added in `2026_05_29`) |
| | `context_text` | `text` | NULLABLE | Session reference knowledge / RAG text (added in `2026_05_29`) |
| `public.chat_message` | `id` | `bigserial` | PK | Message sequence ID |
| | `thread_id` | `uuid` | NOT NULL, FK `chat_thread(id)` ON DELETE CASCADE | Parent thread |
| | `role` | `text` | NOT NULL, CHECK in (`'system'`,`'user'`,`'assistant'`) | Turn role |
| | `content` | `text` | NOT NULL | Message body |
| | `created_at` | `timestamptz` | NOT NULL, `default now()` | Message timestamp |
| `public.widget` | `id` | `text` | PK | Widget ID (e.g. `"muryen"`) |
| | `name` | `text` | NOT NULL, `default 'AI 도우미'` | Display name |
| | `theme` | `text` | NOT NULL, `default 'noir'` | UI theme |
| | `description` | `text` | NOT NULL, `default '온라인...'` | Subtitle |
| | `welcome_message` | `text` | NOT NULL, `default '안녕하세요...'` | Initial bubble greeting |
| | `system_prompt` | `text` | NULLABLE | Default persona prompt |
| | `suggested_questions` | `jsonb` | NOT NULL, `default '[]'::jsonb` | Quick-reply chips |
| | `icon_url` | `text` | NULLABLE | Custom bubble launcher icon URL (added in `2026_05_29`) |
| | `chat_bubble_size` | `text` | NULLABLE | Launcher size (e.g. `"48px"`, `"64px"`) |
| | `is_deleted` | `boolean` | NOT NULL, `default false` | Soft-delete flag |
| | `created_at` | `timestamptz` | NOT NULL, `default now()` | Creation timestamp |
| | `updated_at` | `timestamptz` | NOT NULL, `default now()` | Auto-bumped before update |
| `public._migration_history` | `name` | `text` | PK | Executed SQL filename |
| | `applied_at` | `timestamptz` | NOT NULL, `default now()` | Execution timestamp |

#### Triggers & Functions:
1. `tg_chat_thread_touch()`: Attached to `chat_message` (`AFTER INSERT`). Executes `UPDATE chat_thread SET updated_at = now() WHERE id = NEW.thread_id;`.
2. `tg_widget_touch()`: Attached to `widget` (`BEFORE UPDATE`). Automatically updates `NEW.updated_at = now();`.
3. `admin_exec_sql(text)`: Security-definer stored procedure owned by `postgres` allowing arbitrary DDL execution; execution restricted strictly to `service_role`.
4. Storage Bucket `widget-icons`: Public bucket for launcher images with public-read policy and service-role-only write policy.

### 4.2 Data Access Layer (`lib/chat-store.ts` & `lib/widget-store.ts`)
- **`chat-store.ts`**:
  - `createThread(widgetId)`: Inserts a new row and returns UUID.
  - `getThread(threadId, widgetId?)`: Retrieves thread row, enforcing tenant separation when `widgetId` is provided.
  - `listMessages(threadId, limit = 50)`: Returns messages ordered chronologically.
  - `appendMessage(threadId, role, content)`: Inserts a single message turn.
  - `listWidgets(limit = 1000)`: In-memory JavaScript aggregation of distinct `widget_id`s, counts, and latest activity (workaround for Supabase-js lack of native `GROUP BY`).
  - `listThreads(widgetId, limit = 100)`: Batched two-query lookup fetching thread metadata and latest message preview via `.in("thread_id", ids)`.
  - `renameThread(threadId, widgetId, title)`: Renames session label.
  - `updateThreadPrompt(threadId, widgetId, patch)`: Selectively updates `system_prompt` and `context_text` (capped at 20,000 chars).
- **`widget-store.ts`**:
  - `getWidget(id)`: Returns active widget configuration.
  - `listWidgetsRegistered()`: Lists all non-deleted widget configurations.
  - `upsertWidget(input)`: Executes `.upsert(patch, { onConflict: "id" })` with partial patch semantics.
  - `deleteWidget(id)`: Soft-deletes widget (`is_deleted = true`).

### 4.3 Self-Serve Migration Pipeline
Because Vercel serverless functions cannot read local filesystem directories (`supabase/migrations/`) at runtime:
1. `scripts/build-migrations.mjs` runs before esbuild bundling (`npm run bundle:api`). It reads all `.sql` files in lexicographical order and serializes them into `src/generated-migrations.ts` as string constants in `MIGRATIONS`.
2. `POST /v2/admin/db/migrate` (guarded by `X-Admin-Token` matching `ADMIN_TOKEN`) reads `_migration_history`, filters for unapplied files, and executes them in sequence via `supabaseClient.rpc("admin_exec_sql", { sql: m.content })`. It supports `{ dryRun: true }` for safe inspection.

---

## 5. Standalone Scripts (`scripts/`)

The repository includes operational tools executable via `node --env-file=.env` or `bun`.

| Script | Command | Purpose & Description | Key Safety Features |
|---|---|---|---|
| `send-greetings.ts` | `npm run greetings` | Bulk SMS sender for personalized holiday greetings. Reads `contacts.csv` and `greeting.txt`. | **Dry-run by default**: Requires explicit `--send` to transmit. `--limit N` / `--skip N` batching. Throttled by `SMS_SEND_DELAY_MS`. |
| `sms-verify.ts` | `npm run sms:verify` | Post-hoc delivery status auditor inspecting macOS Messages database (`chat.db`). | Read-only mode (`-readonly` flag on `sqlite3`). Requires Full Disk Access. |
| `sms-devices.ts` | `npm run sms:devices` | Device discovery utility for Pushbullet connected devices and macOS Messages SMS services. | Read-only discovery. |
| `sms-usage.ts` | `npm run sms:usage` | Displays monthly SMS usage and quota consumption from `.sms-usage.json`. | Read-only inspection. |
| `send-test-mail.ts` | `npm run mail:test` | Direct CLI test harness for Naver SMTP email sending (`lib/mail/naver.ts`). | Requires configured credentials; tests single recipient without running server. |
| `upsert-widget.ts` | `npm run widget:upsert` | CLI manager for the `widget` table. Lists registered widgets (`--list`) or upserts persona configurations (`--id`, `--system-prompt`). | Requires `ADMIN_TOKEN`. Enforces validation before HTTP dispatch. |
| `seed-muryen-widget.ts` | `bun scripts/seed-muryen-widget.ts` | Seeds the official "muryen" (武緣) widget persona with grounded martial arts domain knowledge. | Fixed grounded facts; prevents LLM hallucinations regarding dates/locations. |
| `build-migrations.mjs` | `node scripts/build-migrations.mjs` | Code generator compiling `supabase/migrations/*.sql` into `src/generated-migrations.ts`. | Lexicographical sorting; runs automatically during `npm run bundle:api`. |
| `build-vercel.mjs` | `node scripts/build-vercel.mjs` | Bundles `lambda-src/handler.ts` into `.vercel/output/` (Vercel Build Output API v3 format). | Clean build artifact isolation. |
| `fill-widget-reference-image-embedding.ts` | `bun run scripts/fill-...` | Batch processor generating Voyage AI vector embeddings for widget reference images. | Checks for existing embeddings; skips empty descriptions. |

---

## 6. Technical Debt & Refactoring Opportunities

### 6.1 Critical Production Issue: Bundle Drift
- **Observation**: `api/index.js` was committed on 2026-08-19 (commit `212ab1a8`). The subsequent commits on 2026-09-15 (commit `acbe29df`) and 2026-09-17 (commit `624bd68d`) introduced `lib/sms/imessage.ts`, `imessage-verify.ts`, and updated `lib/sms/index.ts`.
- **Impact**: Searching `api/index.js` for `sendViaIMessage` yields 0 matches. The production serverless function running on Vercel is **out of sync** with the source code and cannot execute iMessage features.
- **Remediation**: Automate bundling in CI/CD (R1 of original request) or ensure `npm run bundle:api` is strictly enforced pre-commit.

### 6.2 Outdated Database Types & Untyped Client
- **Observation**: `lib/supabase/database.types.ts` is missing `chat_thread`, `chat_message`, and `widget`.
- **Impact**: All store operations in `lib/chat-store.ts` and `lib/widget-store.ts` bypass TypeScript safety using `supabaseUntyped` (casting to `any`). A raw TypeScript check (`tsc`) produces over 1,100 errors.
- **Remediation**: Run `npm run introspection` against the live Supabase instance and remove `supabaseUntyped`.

### 6.3 Dead/Unmounted Legacy Endpoints
- **Observation**: Inactive endpoint directories in `src/endpoints/v1/` (`account`, `widget`, `billing`, `chat`, `office`, etc.) are not mounted in `v1-endpoints.ts`. Files like `src/endpoints/v1/office/send-sms.ts` still import `from "@/lib/sms/solapi"`, a file that was deleted months ago.
- **Impact**: `npm run build` (`tsc`) fails, forcing `vercel.json` to configure `"buildCommand": "echo skip"`.
- **Remediation**: Remove or archive unused v1 endpoint directories, or repair their type signatures and imports to allow standard `tsc` verification in CI.

### 6.4 Non-Lazy Module-Level Instantiations
- **Observation**: While `lib/supabase/client.ts`, `lib/mail/naver.ts`, and `lib/sms/` strictly adhere to the lazy initialization pattern, other utilities do not:
  - `lib/storage/r2Client.ts` (lines 6–13): `new S3({ ... credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, ... } })`
  - `lib/jwt.ts` (line 6): `const secretKey = process.env.JWT_SECRET_KEY!;`
  - `lib/ai/openai.ts` (lines 3–5): `new OpenAI({ apiKey: process.env.OPEN_AI_API_KEY })`
  - `lib/api-key.ts` (line 4): `export const OPEN_AI_API_KEY = process.env.OPEN_AI_API_KEY!;`
- **Impact**: If any of these modules are imported by an active endpoint, missing environment variables could cause top-level exceptions, resurrecting the cold-start crash issue.
- **Remediation**: Refactor these modules to use the lazy accessor pattern (`let cached = null; function getClient() { ... }`).

### 6.5 Browser APIs in Server Code
- **Observation**: `lib/api/llm.ts` (line 55) executes `URL.createObjectURL(...)`.
- **Impact**: `URL.createObjectURL` is a browser DOM API not supported in standard Node.js environments. Calling this method at runtime will throw a `TypeError`.
- **Remediation**: Isolate or remove client-side SDK code from server utility libraries.

### 6.6 Hardcoded Model Caps
- **Observation**: `lib/llm/openai-compatible.ts` (line 61) hardcodes:
  ```typescript
  max_tokens: Math.min(req.maxTokens ?? 256, 256)
  ```
- **Impact**: Even if a client specifies `maxTokens: 1024` or sets `LLM_MAX_TOKENS=1024` in `.env`, the output is forcefully capped at 256 tokens.
- **Remediation**: Make the 256-token ceiling configurable via environment variables or provider options rather than hardcoding it across all vendors.
