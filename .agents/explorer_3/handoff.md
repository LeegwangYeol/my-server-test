# Handoff Report — Explorer 3: Subsystems, Stores, Scripts & Utilities

**Date**: 2026-09-17 (UTC 2026-09-17T11:27:00Z)  
**Agent**: Explorer 3  
**Working Directory**: `/Users/user/src/my-server-test/.agents/explorer_3`  
**Handoff Type**: Hard (Investigation complete)

---

## 1. Observation

1. **Supabase Lazy Proxy Implementation**:
   - In `lib/supabase/client.ts` (lines 25–35):
     ```typescript
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
   - In `lib/supabase/client.ts` (lines 52–53):
     ```typescript
     export const supabaseUntyped = supabaseClient as unknown as { from: (table: string) => any };
     ```
2. **LLM Provider Engine**:
   - In `lib/llm/types.ts` (lines 24–33): `LLMProvider` interface defines `readonly name: string` and `stream(req: LLMStreamRequest, signal?: AbortSignal): AsyncIterable<string>`.
   - In `lib/llm/factory.ts` (lines 8–50): Preset dictionary defines configurations for `openrouter`, `openai`, `groq`, `together`, `deepseek`, `mistral`, `fireworks`, and `custom`.
   - In `lib/llm/openai-compatible.ts` (line 61): Hard ceiling on output tokens:
     ```typescript
     max_tokens: Math.min(req.maxTokens ?? 256, 256)
     ```
   - In `src/endpoints/v2/widget-endpoints.ts` (lines 209–214): Transport percent-encoding for SSE stability:
     ```typescript
     const safe = text
       .replace(/%/g, "%25")
       .replace(/ /g, "%20")
       .replace(/\n/g, "%0a")
       .replace(/\r/g, "%0d");
     ```
3. **SMS Engine & Provider State**:
   - In `lib/sms/index.ts` (lines 22–31): `activeProvider()` selects `"phone"`, `"pushbullet"`, or `"imessage"`. It defaults to `"phone"` and explicitly treats `"solapi"` as a fallback to `"phone"`.
   - In git commit `9f1987db9e8bbc201a61471fc3473ae98cf52acf`: `lib/sms/solapi.ts` was deleted due to corporate account liability.
   - In `lib/sms/imessage.ts` (line 27): `osascript` invocation passes phone number and text as CLI arguments (`argv`) rather than string interpolation to prevent injection.
   - In `lib/sms/imessage-verify.ts` (lines 34–46, 83–129): Directly inspects `~/Library/Messages/chat.db` using `sqlite3 -readonly -json` to audit `is_sent`, `is_delivered`, and `error` codes.
   - In `lib/sms/usage.ts` (lines 25–45): Reads and writes monthly send counts to `.sms-usage.json`.
4. **Database Migrations & Schema**:
   - Migration directory `supabase/migrations/` contains 7 `.sql` files (`0000_00_00__migration_runner_bootstrap.sql` through `2026_05_29__widget_icon.sql`).
   - `scripts/build-migrations.mjs` (lines 17–38): Compiles `.sql` files into `src/generated-migrations.ts` exporting `MIGRATIONS`.
   - `src/endpoints/v2/widget-endpoints.ts` (lines 468–535): `POST /v2/admin/db/migrate` applies unrecorded migrations using Supabase RPC `admin_exec_sql`.
   - `lib/supabase/database.types.ts`: Contains 2,788 lines of legacy schema definitions but lacks `chat_thread`, `chat_message`, and `widget`.
5. **Operational Scripts**:
   - `scripts/send-greetings.ts`: Defaults to dry-run mode without `--send`; supports `--limit` and `--skip`; enforces `SMS_SEND_DELAY_MS`.
   - `scripts/sms-verify.ts`: Post-hoc delivery status auditor.
   - `scripts/sms-devices.ts`: Discovers Pushbullet devices and macOS SMS accounts.
6. **Bundle Drift & Dead Code**:
   - Running `git log -n 1 -- api/index.js` shows commit `212ab1a8` on 2026-08-19.
   - Grepping `sendViaIMessage` in `api/index.js` yields 0 matches, confirming that recent iMessage commits (`acbe29df` on 2026-09-15 and `624bd68d` on 2026-09-17) are omitted from the committed bundle.
   - `src/endpoints/v1/office/send-sms.ts` line 2 contains `import { sendSms } from "@/lib/sms/solapi";`, referencing a deleted file.

---

## 2. Logic Chain

1. **Serverless Stability**:
   - Vercel evaluates `api/index.js` at container boot.
   - Because `lib/supabase/client.ts` wraps the client creation in an ES6 `Proxy` trap, initialization is deferred until a route handler accesses a property.
   - Consequently, routes that do not require database access (like health checks or YouTube OAuth endpoints) never trigger client initialization, preventing container crashes even if database environment variables are missing.
2. **Type Safety Compromise**:
   - Because `database.types.ts` has not been re-generated since the creation of `chat_thread`, `chat_message`, and `widget`, strict TypeScript checking flags method chains on these tables.
   - To work around this, `supabaseUntyped` casts the client to `{ from: (table: string) => any }`, bypassing type checks and leaving runtime operations unvalidated by the compiler.
3. **SMS Architecture Shift**:
   - Historical reliance on Solapi was eliminated due to account ownership and liability risks.
   - Zero-cost alternatives were introduced: SMS Gate (`phone`), Pushbullet (`pushbullet`), and AppleScript iMessage (`imessage`).
   - Because iMessage operates through asynchronous carrier forwarding and AppleScript only reports handoff to Messages.app, `imessage-verify.ts` was engineered to query SQLite `chat.db` for actual transport confirmation.
4. **CI/CD Risk**:
   - Because `api/index.js` must be manually bundled via `npm run bundle:api` and committed to git, developers frequently forget to re-bundle when editing source files.
   - Evidence: `api/index.js` has not been re-bundled since August 19, 2026, meaning all September features are dead in production.

---

## 3. Caveats

- **External Services**: No live network requests were made to external APIs (OpenRouter, Pushbullet, Naver SMTP, Supabase, or SMS Gate) to preserve integrity and avoid credential leakage.
- **macOS Permissions**: Full Disk Access for `chat.db` was analyzed from source code; live database access was not executed during this turn.
- **Vercel Runtime**: Analysis of Vercel container behavior is based on the documented architecture in `AGENTS.md`, `vercel.json`, and `lambda-src/handler.ts`.

---

## 4. Conclusion

The utilities, database stores, scripts, and subsystem engines in `my-server-test` exhibit sophisticated resilience patterns (such as the Lazy Proxy pattern and safe SMS dry-running), but suffer from severe maintenance drag due to manual build steps and stale artifacts.

Key actionable findings for subsequent refactoring:
1. **Automate CI/CD Bundling**: Implement GitHub Actions to verify or automatically generate `api/index.js` on every pull request/push to eliminate bundle drift.
2. **Regenerate Supabase Types**: Run `npx supabase gen types` to synchronize `database.types.ts`, allowing the deprecation of `supabaseUntyped`.
3. **Prune Inactive Legacy Code**: Delete or isolate unmounted v1 endpoints in `src/endpoints/v1/` that contain broken imports (e.g. `@/lib/sms/solapi`), allowing `tsc` to pass without skipping.
4. **Harmonize Lazy Initialization**: Refactor `lib/storage/r2Client.ts`, `lib/jwt.ts`, and `lib/ai/openai.ts` to follow the Lazy Proxy / accessor pattern.

---

## 5. Verification Method

To independently verify all findings in this report:

1. **Verify Lazy Proxy & Untyped Client**:
   ```bash
   view_file AbsolutePath="/Users/user/src/my-server-test/lib/supabase/client.ts"
   ```
2. **Verify Production Bundle Drift**:
   ```bash
   grep -n "sendViaIMessage" /Users/user/src/my-server-test/api/index.js
   # Returns 0 results, proving the production bundle lacks the latest commits.
   ```
3. **Verify Stale Solapi Import in Inactive Endpoints**:
   ```bash
   grep -n "solapi" /Users/user/src/my-server-test/src/endpoints/v1/office/send-sms.ts
   # Confirms broken reference to non-existent "@/lib/sms/solapi".
   ```
4. **Verify Generated Migrations Compilation**:
   ```bash
   view_file AbsolutePath="/Users/user/src/my-server-test/scripts/build-migrations.mjs"
   view_file AbsolutePath="/Users/user/src/my-server-test/src/generated-migrations.ts"
   ```
5. **Verify SMS Subsystem Structure**:
   ```bash
   ls -la /Users/user/src/my-server-test/lib/sms/
   ```
