# BRIEFING — 2026-09-17T11:20:59Z

## Mission
Analyze serverless runtime, deployment, bundling, adapter architecture, and configuration in `my-server-test`.

## 🔒 My Identity
- Archetype: Explorer
- Roles: Teamwork explorer (Read-only investigation)
- Working directory: /Users/user/src/my-server-test/.agents/explorer_1
- Original parent: a42a9166-26c5-42d2-b4a0-eafbee609c2f
- Milestone: Architectural Analysis & Serverless Runtime Exploration

## 🔒 Key Constraints
- Read-only investigation — do NOT implement or modify project code
- Target output files: report.md and handoff.md in /Users/user/src/my-server-test/.agents/explorer_1/
- Communicate back to parent orchestrator via send_message

## Current Parent
- Conversation ID: a42a9166-26c5-42d2-b4a0-eafbee609c2f
- Updated: not yet

## Investigation State
- **Explored paths**: `lambda-src/handler.ts`, `api/index.js`, `vercel.json`, `package.json`, `tsconfig.json`, `src/app.ts`, `src/index.ts`, `AGENTS.md`, `lib/supabase/client.ts`, `lib/sms/index.ts`, `scripts/build-migrations.mjs`, `scripts/build-vercel.mjs`, `src/endpoints/healthz.ts`, `src/endpoints/v2/widget-endpoints.ts`.
- **Key findings**:
  1. `lambda-src/handler.ts` converts Node `IncomingMessage` to WHATWG `Request` with `duplex: "half"` for streaming bodies, and streams WHATWG `Response.body` chunks directly to `ServerResponse.write()` to support SSE LLM streaming (`/v2/ask`).
  2. `api/index.js` (~28MB) is pre-bundled and committed to git because Vercel scans `api/` before running build scripts; SQL migrations are inlined into `src/generated-migrations.ts` by `scripts/build-migrations.mjs`.
  3. `buildCommand: "echo skip"` in `vercel.json` overrides `"build": "tsc"`, preventing ~1100 TypeScript type errors from failing the Vercel build.
  4. `vercel.json` negative lookahead rewrite `/((?!api/).*)` routes all application routes to `/api` (`api/index.js`) while preserving `req.url` and static files in `public/`.
  5. Fatal module-load cold start crashes (`FUNCTION_INVOCATION_FAILED`) are avoided by using a Lazy Proxy (`new Proxy`) for `supabaseClient` and lazy guards for SMS providers.
  6. Local dev runs Bun daemon with `createApp(false)` (`app.listen()`), while production runs on Node 20.x serverless with `createApp(true)` (`app.handle()`).
- **Unexplored areas**: None within the scope of Explorer 1 assignment.

## Key Decisions Made
- Proceed with thorough examination of lambda-src/handler.ts, api/index.js, vercel.json, package.json, tsconfig.json, src/app.ts, src/index.ts, and AGENTS.md.
- Generated comprehensive architectural report at `report.md`.
- Prepared 5-component handoff at `handoff.md`.

## Artifact Index
- report.md — Comprehensive architectural and runtime analysis report
- handoff.md — 5-component handoff report for parent orchestrator
