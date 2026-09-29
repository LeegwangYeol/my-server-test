# Worker 1 Dispatch

## Mission
Author the master, production-grade architectural specification document (`ARCHITECTURE.md`) based on the exhaustive findings from Explorer 1, Explorer 2, and Explorer 3.

## Target Output Path
`/Users/user/.gemini/antigravity/brain/35edf65c-137b-4bc8-892f-a3fc066b4b80/ARCHITECTURE.md`

## Input Reports
1. Explorer 1 Report (Runtime, Bundling, Serverless Architecture):
   `/Users/user/src/my-server-test/.agents/explorer_1/report.md`
2. Explorer 2 Report (Active & Inactive Endpoint Catalog, Lifecycle, Auth):
   `/Users/user/src/my-server-test/.agents/explorer_2/report.md`
3. Explorer 3 Report (Subsystems, Stores, Migrations, Scripts, Technical Debt):
   `/Users/user/src/my-server-test/.agents/explorer_3/report.md`

## Mandatory Requirements for ARCHITECTURE.md
1. **Executive Summary & System Overview**:
   - High-level architecture, technology stack (Elysia, TypeScript, Node.js 20.x, Vercel Serverless, Supabase Postgres).
   - Core capabilities (YouTube OAuth & management, embeddable LLM chat widget backend, zero-cost SMS gateway, admin tools).
2. **Component & Layer Architecture**:
   - Complete architectural layering diagram in Mermaid (`graph TD` or `flowchart TD`) showing Clients -> Vercel Edge/Routing -> Node Serverless Runtime -> Handler Adapter -> Elysia App -> Endpoint Routes -> Services/Stores -> External APIs & Database.
   - Component dependency diagram visualizing module interactions.
3. **Data Flow & Request Lifecycle**:
   - Standard Request Lifecycle (with Mermaid sequence diagram): Vercel rewrite -> Node http incoming request -> `lambda-src/handler.ts` Web Request creation -> Elysia pipeline (CORS, Swagger, validation) -> Route handler -> Supabase/External -> Response streaming back to Node `res`.
   - Streaming SSE Lifecycle for `/v2/ask` (with detailed Mermaid sequence diagram): Length guard -> Widget validation -> User message persistence -> Prompt construction -> LLM streaming chunks -> Percent-encoding framing (`%25`, `%20`, `%0a`, `%0d`) -> Stream flush to client -> Turn persistence in finally block -> Error fallback.
4. **Exhaustive Endpoint Catalog**:
   - Active Endpoints table: Method, URL path, Auth requirement, Schema/Validation, Request Body/Params, Response format, Handler file, and operational notes. (Must include `/`, `/v1/healthz`, `/v1/heartbeat`, 8 YouTube endpoints, 3 public v2 widget endpoints, 11 v2 admin endpoints including `/mail/send` and `/sms/send`).
   - Inactive / Unmounted Endpoints catalog: Table and deep analysis of all 21 unmounted directory trees (120+ files) under `src/endpoints/v1/` (`account`, `billing`, `workspace`, `botstore`, `kakao`, `scrap`, `office`, `agent`, etc.), explaining why they exist, why they are unmounted, and their technical debt impact.
5. **Special Architectural Patterns**:
   - Vercel Node Serverless Single CJS Bundle Pattern: Why `api/index.js` (~28MB) is pre-bundled via esbuild and committed to git; why `buildCommand: "echo skip"` is required in `vercel.json`; how `build-migrations.mjs` inlines SQL migrations into TypeScript string constants (`src/generated-migrations.ts`); and how the Node `IncomingMessage` ↔ Web `Request`/`Response` adapter handles streaming bodies.
   - Supabase Lazy Proxy Pattern: Detailed breakdown of `lib/supabase/client.ts`. Why direct module-level initialization crashes serverless functions (`FUNCTION_INVOCATION_FAILED`) on cold starts when credentials are absent; how `new Proxy` traps property lookups (`get`) to defer client instantiation until the exact moment a DB query is executed; and the `supabaseUntyped` escape hatch.
6. **Subsystem Deep Dives**:
   - LLM Multi-Vendor Engine (`lib/llm/`): Architecture of `LLMProvider`, OpenAI-compatible provider covering 8 vendor presets, token capping, prompt hierarchy (thread -> widget persona -> global fallback), transport percent-encoding for SSE, and simulated fallback streaming.
   - SMS Multi-Provider Engine (`lib/sms/`): Provider switching via `SMS_PROVIDER` across 3 zero-cost backends (`phone` via SMS Gate Android app, `pushbullet` via Pushbullet API, `imessage` via macOS `osascript`), retirement of Solapi, anti-spam delay (`SMS_SEND_DELAY_MS`), local usage tracking in `.sms-usage.json`, and delivery verification via SQLite query to `chat.db`.
   - YouTube OAuth & Data API: Stateless OAuth flow via Base64-encoded `state` parameter, token exchange, client-held token architecture, and Elysia status code handling.
   - Widget Master & Persistence Architecture: Data model (`widget_master`, `chat_thread`, `chat_message`), session configuration override, and migration management.
7. **Operational Scripts & CLI Tools**:
   - Comprehensive analysis of `scripts/`: `send-greetings.ts` (dry-run safety, personalized templates, batch slicing), `sms-devices.ts`, `sms-usage.ts`, `sms-verify.ts`, `build-migrations.mjs`.
8. **Concrete Areas for Refactoring & Modernization**:
   - Bundle synchronization & automated CI/CD to prevent bundle drift.
   - Dead code removal: clean up or modularize 120+ inactive v1 legacy files.
   - Fix outdated `database.types.ts` and eliminate `supabaseUntyped`.
   - Fix YouTube handler error status codes (explicit `set.status = 400`).
   - Lazy Proxy pattern expansion to other legacy singletons (`lib/storage/r2Client.ts`, `lib/jwt.ts`).
   - Rate limiting and automated testing strategy.

## Strict Constraints
- ABSOLUTELY NO CODE MODIFICATIONS in `/Users/user/src/my-server-test`.
- Write ONLY to `/Users/user/.gemini/antigravity/brain/35edf65c-137b-4bc8-892f-a3fc066b4b80/ARCHITECTURE.md` and metadata under your working directory `/Users/user/src/my-server-test/.agents/worker_1/`.
