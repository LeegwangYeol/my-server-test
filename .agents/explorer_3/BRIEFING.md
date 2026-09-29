# BRIEFING — 2026-09-17T11:27:00Z

## Mission
Analyze all utilities, stores, subsystem engines, scripts, database migrations, and architectural patterns in `my-server-test`.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigation, synthesis
- Working directory: /Users/user/src/my-server-test/.agents/explorer_3
- Original parent: a42a9166-26c5-42d2-b4a0-eafbee609c2f
- Milestone: exploration

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- STRICT CONSTRAINT: ABSOLUTELY NO CODE MODIFICATIONS in /Users/user/src/my-server-test outside .agents/explorer_3/
- Do not ask user questions; make reasonable assumptions and proceed

## Current Parent
- Conversation ID: a42a9166-26c5-42d2-b4a0-eafbee609c2f
- Updated: 2026-09-17T11:27:00Z

## Investigation State
- **Explored paths**:
  - `lib/supabase/client.ts` (Lazy Proxy pattern & untyped client)
  - `lib/llm/` (`types.ts`, `openai-compatible.ts`, `factory.ts`, `index.ts`)
  - `lib/sms/` (`index.ts`, `phone-gateway.ts`, `pushbullet.ts`, `imessage.ts`, `imessage-verify.ts`, `usage.ts`)
  - `lib/chat-store.ts`, `lib/widget-store.ts`
  - `supabase/migrations/` (all 7 migration files)
  - `scripts/` (`send-greetings.ts`, `sms-devices.ts`, `sms-usage.ts`, `sms-verify.ts`, `send-test-mail.ts`, `upsert-widget.ts`, `seed-muryen-widget.ts`, `build-migrations.mjs`, `build-vercel.mjs`, etc.)
  - `.env.example`, `package.json`, `api/index.js`, `src/app.ts`, `lambda-src/handler.ts`
  - Auxiliary utilities: `lib/mail/naver.ts`, `lib/ai/`, `lib/storage/`, `lib/jwt.ts`, `lib/api-key.ts`
- **Key findings**:
  - Supabase Lazy Proxy completely shields cold start from missing DB env vars.
  - Multi-vendor LLM provider wraps 8 presets with SSE stream parsing and token capping.
  - SMS system transitioned from Solapi to 3 zero-cost providers (`phone`, `pushbullet`, `imessage`) with local usage tracking and SQLite `chat.db` verification.
  - Inlined SQL migration runner (`POST /v2/admin/db/migrate`) driven by `build-migrations.mjs`.
  - Significant production bundle drift detected (`api/index.js` missing recent commits).
  - Outdated `database.types.ts` forces `supabaseUntyped` and causes 1100+ TS errors.
  - Inactive legacy endpoints contain broken imports (`@/lib/sms/solapi`), requiring `echo skip` in `vercel.json`.
- **Unexplored areas**: None within assigned scope.

## Key Decisions Made
- Fully documented all 6 required analytical areas in `report.md`.
- Prepared self-contained 5-component handoff in `handoff.md`.

## Artifact Index
- `/Users/user/src/my-server-test/.agents/explorer_3/report.md` — Full comprehensive analysis report
- `/Users/user/src/my-server-test/.agents/explorer_3/handoff.md` — 5-component handoff report
- `/Users/user/src/my-server-test/.agents/explorer_3/progress.md` — Progress tracker
- `/Users/user/src/my-server-test/.agents/explorer_3/BRIEFING.md` — Situational awareness memory
