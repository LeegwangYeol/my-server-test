# Explorer 2 Dispatch

## Mission
Analyze all active and inactive endpoints, routing structure, authentication, request validation, and request/response lifecycles in `my-server-test`.

## Scope & Target Files
- `src/app.ts`
- `src/endpoints/healthz.ts`
- `src/endpoints/v1/v1-endpoints.ts`
- `src/endpoints/v1/youtube/` (all files)
- Inactive endpoints: `src/endpoints/v1/account/`, `widget/`, `billing/`, `chat/`, etc.
- `src/endpoints/v2/widget-endpoints.ts`
- `src/endpoints/v2/mail-endpoints.ts`

## Instructions
1. This is a STRICT READ-ONLY exploration. Do NOT modify any source files.
2. Produce an exhaustive endpoint catalog:
   - Explicitly list EVERY active endpoint: Method, URL path, Auth requirements, Elysia Schema/Validation, Request body/parameters, Response structure, Handler file & implementation notes.
   - Explicitly list EVERY inactive/unmounted endpoint found in `src/endpoints/`: Method, URL path, Handler file, why it is unmounted/inactive, what it does.
   - Detailed analysis of `/v2/ask`: SSE (Server-Sent Events) streaming lifecycle, error handling, thread persistence, and LLM orchestration.
   - Detailed analysis of YouTube OAuth flow (`/v1/youtube/auth/create`, `/v1/youtube/auth/confirm`) and data operations (`channel`, `video`, `comment`, `reply`).
   - Authentication mechanisms: `x-admin-token` verification in `widget-endpoints.ts` (`requireAdmin`), `MAIL_SEND_TOKEN` fallback, fail-closed security design.
3. Write your comprehensive report to `/Users/user/src/my-server-test/.agents/explorer_2/report.md` and your handoff to `/Users/user/src/my-server-test/.agents/explorer_2/handoff.md`.
## 2026-09-17T11:21:00Z
4. Message parent orchestrator when complete.
