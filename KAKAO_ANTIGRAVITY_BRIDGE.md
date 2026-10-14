# 카카오톡으로 Antigravity 세션 다루기 — 조사·설계·아이디어

작성 2026-10-09. 에이전트 조사 3회(1차 개요 4개, 2차 심층 4개, 3차 아이디어 보강 4개) 결과를 한 파일로 정리함.
표기: **VERIFIED** = 공식 문서·로컬 파일로 확인, **UNVERIFIED** = 커뮤니티·추론. 로컬 경로는 이 PC 기준.

---

## 0. 결론 요약

- 카톡으로 Antigravity 세션을 다루는 것은 **공식 기능만으로 가능**. 비공식 해킹(CDP, 내부 RPC, 카톡 봇 계정) 불필요.
- 최종 추천 경로:

```
카톡 채널 챗봇 → Vercel /v2/relay/kakao/skill (IP·헤더·발신자 검증, 즉시 "접수")
  → Supabase relay_job + Realtime 초인종
  → PC agent-bridge sidecar (Antigravity 공식 sidecar)
  → agentapi new-conversation / send-message
  → Stop 훅이 transcript.jsonl 읽음
  → 50초 안: callbackUrl 로 답장 / 초과: "진행 중 #id" → '결과' 버튼으로 조회 + 메일 알림
```

- 시작 전 결정 사항 (6절) — 특히 **보안**: 이 PC의 Antigravity 는 자동실행 EAGER·샌드박스 OFF·powershell 전역 허용 상태라 채팅 연결 = 원격 셸.
- 확장 아이디어 28개 (5절): 폰 UX 7, Antigravity 고도화 7, 플랫폼화 7, 대체·폴백 채널 7. 단계별 로드맵은 5.5절.
- **가장 먼저 할 일**: PreToolUse·Stop 훅이 이 버전(2.21.1)에서 실제로 호출되는지 프로브. 데스크톱 2.5.0 에서는 호출 안 됐다는 보고가 있고, 승인 게이트·답장 경로가 전부 훅에 달려 있음.

---

## 1. Antigravity 제어 수단 (VERIFIED, 로컬 확인)

### 1.1 설치 현황
| 항목 | 값 |
|---|---|
| 데스크톱 앱 | `%LOCALAPPDATA%\Programs\Antigravity` (2.0, v2.21.1 / 2026-10-07). 내부 `resources\bin\language_server.exe` |
| IDE | `%LOCALAPPDATA%\Programs\Antigravity IDE` (VS Code 1.107 fork). CLI `antigravity-ide chat "프롬프트" -m agent`, `tunnel`, `serve-web` 서브커맨드 있음 |
| agy CLI | 미설치 (`~/.gemini/antigravity-cli` 없음) |
| Remote Control | `config.json` `remoteControlEnabled=true` (이미 켜짐) |
| 기존 sidecar | `~/.gemini/config/sidecars/window-watch-dog/sidecar.json` (cron, 매일 10:00) |
| sidecar SDK | `~/.gemini/config/node_modules/sidecar_sdk/index.mjs` (공식 Node SDK, Windows 에서 agentapi 호출법 포함) |

### 1.2 agentapi — 유일한 공식 "세션에 메시지 넣기" 수단
`language_server.exe agentapi --help` 실측:
```
get-conversation-metadata <conversation_id>
new-conversation [--model=<flash_lite|flash|pro>] [--title=<title>] [--profile=<profile>] <prompt>
send-message [--title=<title>] <recipient_id> <content>
```
- **답변을 읽는 명령 없음** → 출력은 훅/transcript 로만 가능.
- **sidecar 안에서만 동작**: `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_AGENTAPI_EXE`, `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 를 앱이 주입. 밖에서 실행하면 `{"error":"ANTIGRAVITY_LS_ADDRESS is not set"}`.
- 출력: stdout JSON 1개 `{"response":{...},"error":"..."}`, 실패 시 exit 1. 호출마다 `~/.gemini/antigravity/sidecar_data/<id>/events/*.json` 기록.
- **쉬고 있는 대화에 send-message 하면 깨어남** (brain 폴더 기록 289건: 120초 이상 idle 대화에 메시지 도착 후 0.5~19초 뒤 새 step 시작). 단, `<SYSTEM_MESSAGE> not actually sent by the user...` 형태로 주입됨.
- `new-conversation` 은 **projectId 필수**. WINDOW-WATCH-DOG 실패 원인이 이것 (아래).

### 1.3 WINDOW-WATCH-DOG 현재 상태 — 고장
- 기록된 실행 1건(2026-10-08 11:04 수동)이 `project_id is required when providing project_env_config` 로 실패. `~/.gemini/antigravity/sidecar_data/window-watch-dog/logs/20261008_110448_manual.log`
- 원인: `~/.gemini/config/config.json` 의 `sidecars.window-watch-dog` 에 `enabled:true` 만 있고 `projectId` 없음.
- 수정: `"projectId":"ce652a80-304a-4417-b82f-79bcf5d3080c"` (기존 window-watch-dog 프로젝트 ID) 추가. **사용자 결정 후 적용** (6절).

### 1.4 훅 (Hooks)
- 전역 `~/.gemini/config/hooks.json`, 워크스페이스 `.agents/hooks.json`, 플러그인 `plugins/<name>/hooks.json`.
- 이벤트: `PreToolUse` / `PostToolUse` / `PreInvocation` / `PostInvocation` / `Stop`. stdin JSON 에 `conversationId`, `transcriptPath`, `workspacePaths`; Stop 은 `terminationReason`, `fullyIdle` 추가.
- Windows 는 `cmd /c` 로 실행, **동기(에이전트 루프 차단)**, 기본 timeout 30초, type 은 `command` 만.
- PreToolUse 는 allow / deny / `deny_unless_prior_grant` 결정 반환 가능 → **폰 승인 버튼의 근거**.
- transcript 형식(로컬 확인): `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl`, 줄마다 `step_index, source(USER_EXPLICIT|MODEL), type(USER_INPUT|PLANNER_RESPONSE|...), status, content, thinking, token 수`.
- 세션 목록: `~/.gemini/antigravity/conversation_summaries.db` (SQLite, 평문 컬럼 `conversation_id,title,preview,step_count,last_modified_time,status,project_id`). 읽기 전용으로 `/목록` 응답에 사용 가능. 내부 스키마라 변경 가능.

### 1.5 권한 (중요)
- sidecar 가 만든 대화는 **전역 권한·프리셋 상속**, 그 외 미승인 명령은 자동 거부. `sidecar.json` 의 `agent_permissions.access_grants / workspace_uris` 로 사전 허용 (내장 automation 스킬 문서 `~/.gemini/antigravity/builtin/skills/automation/SKILL.md:130`).
- 이 PC 전역 설정: `autoExecutionPolicy=CASCADE_COMMANDS_AUTO_EXECUTION_EAGER`, `enableTerminalSandbox=false`, 전역 grant 에 `command(powershell)`, `mcp(*)`.
- 따라서 **브리지 전용 프로젝트 + 좁은 권한 + 승인 단계** 없이는 연결 금지.

### 1.6 이용약관
- FAQ: "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service" (https://antigravity.google/docs/faq). 약관 6조는 OpenClaw 등 OAuth 재사용 사례로 정지 발생.
- sidecar / agentapi / hooks 는 **1st-party 확장점**이라 가장 안전. CDP(LazyGravity, AntiCrow)·내부 RPC(Antigravity-Deck) 는 금지 범주.
- agy CLI 를 스크립트로 호출하는 것은 회색 (공식 답변 없음, 커뮤니티는 "토큰 추출 안 하면 OK").

---

## 2. 카카오톡 경로

### 2.1 방법 비교 (점수: 실현성·안전성·작업량·사용감 각 5점)
| 방법 | 점수 | 평가 |
|---|---|---|
| **M1. 채널 챗봇(오픈빌더) 스킬 웹훅 + 콜백 + 결과 조회** | **16** | 사업자 없이 쓸 수 있는 유일한 공식 양방향 |
| M3. 나에게 보내기 API | 14 | 송신 전용, 알림 안 울림(2022 데브톡 staff) |
| M4. PlayMCP '나와의 채팅방' 도구 | 14 | 송신 전용, 서버 코드 없이 에이전트가 직접 호출 |
| M2. M1 + Event API 선제 발송 | 13 | 비즈니스 인증 채널+앱 필요, 건당 15원 |
| M5. 카카오워크 봇 | 12 | 별도 앱, 입력은 버튼/모달만 |
| M6. 비공식(PC 카톡 Win32, 메신저봇R, Iris, LOCO) | 11 | 운영정책 위반, 영구 이용 제한 가능 |

### 2.2 M1 핵심 사실
| 항목 | 값 | 근거 |
|---|---|---|
| 스킬 timeout | 5초 고정 | gitbook make_skill (VERIFIED) |
| callbackUrl | 1회용, **1분** (CS FAQ·오류표) vs 5분(gitbook 본문) → 50초 기준 설계, 실측 필요 | https://cs.kakao.com/helps_html/1073206022 (VERIFIED) |
| 응답 제한 | outputs ≤3, simpleText 1000자(500자 초과 시 '전체 보기'), quickReplies ≤10 | answer_json_format (VERIFIED) |
| 봇 테스트 환경 | callback token 사용 불가 → 배포 후 테스트 | ai_chatbot_callback_guide (VERIFIED) |
| 요청 인증 | 공식 IP `219.249.231.40/41/42` + 스킬 등록 시 커스텀 헤더 + botUserKey allowlist. HMAC 서명 없음 | https://cs.kakao.com/helps_html/1073203399 (VERIFIED) |
| 개인 가능 여부 | 일반 채널은 사업자번호 없이 개설 가능. 챗봇↔채널 연결 요건은 매니저 권한 + 채팅방 메뉴/자동응답 OFF 뿐. 사업자번호는 Developers 앱↔채널 연결·Event API 에만 필요 | gitbook channel/start, tutorial_1; devtalk 150493 (VERIFIED) — 단 미인증 채널 배포를 카카오가 명시 확인한 적 없음 |
| AI 챗봇(콜백) 승인 | 2026-08 이후 심사 폐지 추정(Cloudturing 2026-08-03/10-07, 데브톡 2026-06 "AI 챗봇 관리 탭 사라짐"). 카카오 공식 공지 없음 | UNVERIFIED — 봇 만들어 폴백 블록 '...' 에 Callback 토글 보이는지 10분 확인 |
| 비용 | 채팅 서비스 무료 | cs 1073202468 (VERIFIED) |
| 봇이 먼저 말하기 | Event API 없이는 불가 | VERIFIED |

### 2.3 기존 레포 코드 (등록 안 됨)
`src/endpoints/v1/kakao/chatbot-connect.ts` 에 useCallback 스킬 엔드포인트 초안 존재 (LLAMI 레거시 정리로 삭제됨 — 참고하려면 `git show 2dcd11b:src/endpoints/v1/kakao/chatbot-connect.ts`). 결함:
1. `cf-connecting-ip`(Cloudflare 헤더)로 IP 검사 → Vercel 은 이 헤더를 주지 않음 → **전부 403**.
2. 응답 후 분리된 async IIFE 로 LLM 호출·콜백 POST → Vercel 에서는 `waitUntil` 없이는 실행 보장 없음 (레포 전체에 waitUntil 사용 없음).
3. `src/config/kakao.ts` IP 목록에 현재 공식 목록에 없는 옛 대역 혼재.
→ 재사용 vs 신규 v2 경로: **사용자 결정** (6절).

### 2.4 참고 사례
- lifeissea/kakaotalk (OpenClaw 스킬): Vercel + Supabase 큐 + 로컬 watcher. 목표 구조와 거의 동일. https://clawhub.ai/lifeissea/kakaotalk
- 하리아빠 OpenClaw+카카오 채널 (2026-02): Tailscale Funnel 로 맥 직접 노출. https://www.youtube.com/watch?v=Cwvippc3yKs
- gpters 카톡 AI 자동화 (2026-07): 방식별 정지 위험 비교표. https://www.gpters.org/chatbot/post/gogseong-1gi-katog-ai-jadonghwa-window-mac-gubun-rut6iIS3e9W6ZeK
- folioo-server PR #466 (2026-10-05): `X-Kakao-Skill-Secret` 헤더 인증 운영 코드. https://github.com/Teamie71/folioo-server/pull/466

---

## 3. 디스코드 / 텔레그램 경로

| 방법 | 점수 | 평가 |
|---|---|---|
| **A. Antigravity sidecar 안에서 discord.js 게이트웨이 봇** | **16** | 실제 데스크톱 세션 조작, 포럼 포스트=대화, PreToolUse 훅으로 Allow/Deny 버튼 |
| B. 같은 구조 + 텔레그램 long polling | 16 | 동점. draft 스트리밍·1:1 토픽이 더 좋음. 백엔드 동일하므로 나중에 추가 쉬움 |
| C. Vercel HTTP Interactions + Supabase 큐 | 12 | 슬래시 명령만, 3초 ack/15분 토큰, 어차피 PC 필요 |
| D. agy CLI 헤드리스 봇 | 11 | 기록이 데스크톱과 분리, 승인 불가(soft-deny), 미설치, Windows non-TTY 버그 보고 |
| E. Claude Code Channels | 11 | Claude 전용. Antigravity 대상 불가. 설계 참고용(발신자 게이트, 버튼 승인) |
| F. OpenAB + agy-acp | 8 | Linux 컨테이너 기준, 스트리밍 없음, ToS 위험 최대 |

- 디스코드는 **Vercel 불필요**. 게이트웨이 봇은 PC 에서 outbound WebSocket. MESSAGE_CONTENT intent 필요.
- 같은 Discord 앱에 Interactions Endpoint URL 과 게이트웨이를 동시에 쓸 수 없음.
- 참고: chadingTV/claudecode-discord (한국어 문서, Windows), zebbern/claude-code-discord (SDK 기반 버튼 승인), anthropics/claude-plugins-official discord (Apache-2.0, 설계 기준).
- 별건 발견: `src/utils/log/discord-logger.ts` 에 디스코드 웹훅 URL 2개가 토큰째 하드코딩. 레포 public → **재발급 + env 이동 필요**.

---

## 4. 서버 ↔ PC 중계

| 방법 | 점수 | 평가 |
|---|---|---|
| **(1) Supabase relay_job + Realtime Broadcast 초인종 + Vercel claim API + 60초 폴링 폴백** | **16** | 이미 있는 것만으로 0원, 약 1초, PC 꺼져도 큐 보존 |
| (3) Upstash Redis 리스트 + PC TCP BLMOVE | 15 | 지연 최소. PC 에 Redis 비밀번호 필요, 상태가 두 저장소로 갈라짐, REST 는 blocking 불가 |
| (2) PC 가 Vercel 롱폴 (Remote-Control 방식) | 14 | Hobby 2GB 인스턴스가 24시간 살아 메모리 약 1,440 GB-hr/월 (포함량 360 의 4배) → 프로덕션 일시정지 위험 |
| (5) Cloudflare Worker + Durable Object | 14 | 지연 최상, 플랫폼 이중화 |
| (4) Cloudflare Tunnel / Tailscale Funnel 직접 노출 | 11 | 원격 셸 앞에 인터넷 inbound 엔드포인트 |

### 4.1 (1) 구체 설계 (기존 엔드포인트 변경 없음, app.ts 등록 1줄)
**테이블** `supabase/migrations/2026_10_09__agent_relay.sql`: `relay_device`, `relay_sender`, `relay_job(id, short_no, channel, sender_id, text, status queued|claimed|running|done|failed|expired, reply_route jsonb, idempotency_key UNIQUE, lease_until, created_at)`, `relay_audit`. RLS on. 함수 `relay_claim(p_device, p_lease)` = `FOR UPDATE SKIP LOCKED`.

**엔드포인트** (`src/endpoints/v2/relay-endpoints.ts`)
- 인그레스 `POST /v2/relay/kakao/skill` — `x-real-ip ∈ 공식 IP`, 커스텀 헤더 시크릿, `userRequest.user.id ∈ RELAY_ALLOWED_SENDERS`. insert → Realtime broadcast(빈 payload) → `{version:'2.0',useCallback:true,data:{text:'접수 #12'}}`. idempotency_key = `kakao:`+sha256(callbackUrl).
- 인그레스 `POST /v2/relay/discord/interactions` — Ed25519 검증, type 5 응답.
- 디바이스 `POST /v2/relay/device/claim | /progress | /result | /heartbeat` — `Authorization: Bearer <token>`, sha256 을 `timingSafeMatch` 로 `RELAY_DEVICE_TOKEN_SHA256` 과 비교. 없으면 500, 불일치 401.
- 관리 `POST /v2/admin/relay/enqueue` (E2E 테스트용, requireAdmin).

**PC 워커** `~/.gemini/config/sidecars/phone-relay/{sidecar.json, worker.mjs}`: `{"command":"node","args":["worker.mjs"],"restart_policy":"always","agent_permissions":{...}}` + `config.json` 에 `"phone-relay":{"enabled":true,"projectId":"<id>"}`. supabase-js Realtime 구독 + 60초 폴링. `execFile(ANTIGRAVITY_AGENTAPI_EXE, ['agentapi', ...])` argv 배열(셸 없음). 디바이스 토큰은 sidecar.json env.

**답장 경로** `.agents/hooks.json` Stop 훅 → `sidecar_data/phone-relay/data/outbox/<conversationId>.json` 기록 → 워커가 transcript 의 마지막 `PLANNER_RESPONSE` 읽어 `/device/result` POST → 서버가 reply_route 처리(카카오 callbackUrl 50초 내 / 디스코드 follow-up / 메일).

**보안 4겹**: ① 인그레스 키·서명 ② 발신자 allowlist ③ `승인 <TOTP 6자리>` 로 30분 세션 unlock ④ 위험 도구는 PreToolUse 훅 → 카톡 `yes ab12` 단일 사용 코드, timeout 시 deny.

**Vercel env**: `RELAY_DEVICE_TOKEN_SHA256`, `RELAY_INGRESS_KEY`, `RELAY_ALLOWED_SENDERS`, `RELAY_TOTP_SECRET`, `RELAY_DOORBELL_TOPIC`.

**무료 한도**: Supabase Free Realtime 200연결·2M msg/월; Vercel Hobby 1M 호출/월 (60초 폴백 ≈ 43K/월).

---

## 5. 아이디어 보강 (3차 조사)

표기: 가능성 **now**(바로 가능) / **검증**(테스트 선행) — 작업량 S/M/L — ⚠️ = 기존 설계·결정을 바꾸는 항목(사용자 결정 필요).

### 5.1 폰 UX — 카톡 제약 안에서 쓸 만하게

| # | 아이디어 | 가능성 | 작업량 |
|---|---|---|---|
| U1 | 접두어 없는 기본 명령 + 상태별 quickReply 세트 + `ㄱ/ㄴ/숫자` 단축 ⚠️ | 검증 | M |
| U2 | 승인 카드: PreToolUse 훅이 멈추고 `[승인 ab12][거부 ab12]` 탭으로 해제, 10분 무응답 시 deny | 검증 | M |
| U3 | `/목록`=listCard, `/상태 N`=textCard — DB 조회만이라 5초 안에 항상 즉답 | now | S |
| U4 | diff·테스트 결과를 이미지로 렌더(headless Edge) → 비공개 버킷 → 추측 불가 URL | 검증 | M |
| U5 | 긴 출력 3단계: 에이전트가 쓴 `## 카톡요약` → 1000자×3 페이지 → 토큰 게이트 결과 페이지/메일 | now | S |
| U6 | "봇이 먼저 말 못함" 우회 체인: 나에게 보내기 → 메일 → SMS(승인 이벤트만) | 검증 | M |
| U7 | 음성은 안 만듦 — 키보드 받아쓰기 + 탭 중심 (스킬 응답에 오디오 타입 없음) | now | S |

**U1 대화 예시**
```
나: 테스트 돌리고 실패하면 고쳐줘          ← 접두어 없음 = 현재 프로젝트·대화로
봇: ⏳ #12 접수 · my-server-test
봇(콜백): ✅ #12 완료 (2m10s)
         · healthz 테스트 2건 실패 → chat-store.ts 수정
         · bun test 18/18 통과
         [결과 12][diff 12][커밋 12][중지 12][목록]
나: @tokki 위젯 색 바꿔                     ← 프로젝트 전환(유지)+새 대화 #13
나: ㄱ                                      ← 최근 10분 내 대기 항목이 1개일 때만 승인
```
- 핵심 설계: **PC 가 callbackUrl 을 직접 POST** → Vercel 60초 제한과 무관하게 콜백 유효시간을 끝까지 씀.
- `context.values` 로 마지막 job 을 기억해 `결과`·`중지` 에 번호 생략 허용.
- useCallback 즉시응답엔 template 이 없어 quickReply 를 못 붙임 → 버튼은 콜백 응답에만.

**U2 승인 카드 — 브리지를 켜기 위한 전제 조건**
```
봇: 🔐 승인 요청 ab12 · #12 my-server-test
    $ git push origin HEAD:main
    변경: lib/chat-store.ts +12 −3
    [승인 ab12][거부 ab12][diff 12]
나: [승인 ab12]
봇: ✅ ab12 승인 · 실행 재개
```
- ⚠️ 블로커: 2026-08 포럼 재현에서 데스크톱 2.5.0 은 PreToolUse 훅이 **아예 호출되지 않음**(CLI 만 동작). 이 PC 는 2.21.1 이라 달라졌을 수 있음 → **프로브 훅으로 먼저 확인**. 훅이 안 불리면 승인 카드는 장식이고 브리지는 무방비 원격 셸 → 그 경우 브리지 켜지 말 것.
  https://discuss.ai.google.dev/t/do-antigravity-ide-2-0-actually-execute-plugin-hooks-pretooluse-posttooluse-or-is-that-cli-only-right-now/176814
- 훅 timeout 기본 30초 → 승인 대기용으로 분 단위 상향 필요(상한 미문서). 타임아웃 동작이 미문서라 스크립트가 스스로 170초에 deny 출력.
- `/자동승인 30분 bun test, git diff` 처럼 읽기 전용 명령만 한시 자동 허용.

**U5 긴 출력**: 프로젝트 규칙에 "작업 끝에 `## 카톡요약`(300자) 블록 작성" 추가 → Stop 훅이 추출. 없으면 마지막 400자. 결과 페이지 `GET /v2/relay/result/:id?k=<HMAC>` (24h, noindex, no-store), `[메일로]` 는 기존 `scripts/send-mail.ts`.

**U6 먼저 알리기**: Kakao Developers 앱 1개 + 본인 계정 1회 로그인(talk_message) → refresh token 은 PC 로컬에만. 주 1회 갱신 Automation 이면 영구 유지(잔여 1개월 미만일 때만 새 refresh 발급). 실패 시 메일, 메일도 실패 시 SMS(월 100건이라 승인 이벤트만).

### 5.2 Antigravity 측 — 더 똑똑하고 안전하게

| # | 아이디어 | 가능성 | 작업량 |
|---|---|---|---|
| A1 | 전용 `phone-relay` 프로젝트(자동실행 OFF, 파일·인터넷 ASK) + PreToolUse `gate.mjs` 를 실질 권한 시스템으로 | 검증 | M |
| A2 | **읽기 전용이 기본값** — `/unlock 30m <TOTP>` 로만 쓰기·명령 해제(서버 상태로 관리) | 검증 | M |
| A3 | 폰용 "답변 계약"을 훅으로 강제: PreInvocation 형식 주입 + PostInvocation 루프 상한 + Stop 1회 재요약 | 검증 | M |
| A4 | `@별칭` 멀티 세션 라우팅 + `/새로`, `/이어 N`, `/보관 N` — 별칭마다 프로젝트·모델·대화 ID | 검증 | M |
| A5 | 에이전트 무관 브리지: `@claude` 는 같은 PC 의 `claude -p --output-format json --resume` ⚠️ | now | M |
| A6 | Automations 아침 요약 → 메일 즉시 + 카톡은 "다음 메시지에 얹어서" | now | S |
| A7 | 계획·diff·스크린샷은 링크로 + Remote Control 딥링크 `[세션 열기]` 버튼 | 검증 | M |

- **A1/A2 가 왜 필요한가**: sidecar 대화는 전역 설정(EAGER, 샌드박스 OFF, powershell·mcp(*) 허용, `.gemini` 폴더 읽기 허용)을 그대로 상속. 훅의 deny 는 즉시 하드 차단이라 1st-party 로 권한을 좁히는 유일한 수단.
  - 프로젝트 설정 예: `autoExecutionPolicy: OFF`, `fileAccessPolicy: ASK`, `internetPolicy: ASK`, `artifactReviewMode: ALWAYS`, 워크스페이스는 빈 전용 폴더.
  - 커스텀 에이전트 `.agents/agents/phone-relay.md` 의 `tools:` 화이트리스트로 서브에이전트·브라우저·MCP 호출 자체를 차단.
  - 잠금 상태에서도 `view_file` 로 비밀 파일을 읽을 수 있으므로 `.env`, `.gemini` 읽기 deny 를 별도로.
  - 미확인: agentapi 로 만든 대화에 커스텀 에이전트를 지정하는 방법(`--profile` 의미).
- **A3 이유**: 전역 AGENTS.md 규칙("축약 금지·트리 구조·끝까지 파고들기·서브에이전트 강제")이 폰 세션에도 로드됨. 훅으로 매 호출 `PHONE MODE: 900자, 첫 줄 결론` 주입 + 20~30회 호출 상한 + Stop 에서 길면 1회 재요약. 무한 재시도 가드(executionNum) 필수.
- **A4 라우팅 규칙**: 별칭의 대화가 idle·2시간 이내면 `send-message`, 아니면 `new-conversation --title "kakao:<별칭>#<n>"` 을 `ANTIGRAVITY_PROJECT_ID=<별칭 프로젝트>` 로 실행(SDK 가 호출별 env 주입 지원). 각 별칭 프로젝트에 A1 의 OFF/ASK 오버라이드를 넣기 전엔 등록 금지.
- **A5 장점**: Claude `-p` 는 결과·session_id·비용을 JSON 으로 바로 돌려줘서 훅·transcript 파싱이 필요 없음. 승인 게이트는 같은 `gate.mjs` 를 `.claude/settings.json` PreToolUse 로 재사용. ⚠️ 사용자 CLAUDE.md 의 "NO subagents" 규칙과의 관계는 결정 필요.
- **A7**: Remote Control 딥링크 `https://antigravity.google.com/r/<instance-id>?p=c%2F<conversation-id>` — 폰 PWA 에서 계획 리뷰·도구 확인 응답을 앱 UI 로. 카톡은 명령·짧은 답·링크 허브, 긴 검토는 PWA.

### 5.3 플랫폼화 — 릴레이를 재사용 가능한 모듈로 (기존 엔드포인트 무변경, `/v2/relay/*` 추가만)

| # | 아이디어 | 가능성 | 작업량 |
|---|---|---|---|
| P1 | 채널 × 실행기 플러그인 레지스트리 + **서버 측 `llm` 실행기**(PC 꺼져도 Tokki 페르소나로 답) ⚠️ | 검증 | L |
| P2 | 기기 등록(`/기기등록` → 10분 코드) + 기기별 해시 토큰·capability — 맥도 실행기로 | now | M |
| P3 | MCP 엔드포인트 `/v2/relay/mcp` — claude.ai·Antigravity·Claude Code 가 작업 넣기·주인 알림 | 검증 | M |
| P4 | 웹 콘솔 `/relay/console` (카톡에서 1회용 링크로 로그인) — 긴 출력·승인·이력 | now | M |
| P5 | 인바운드 웹훅 → 작업: GitHub CI 실패 → "승인 #15" 로 원인 분석 착수 | now | M |
| P6 | pg_cron 예약 작업 — `/예약 매일 23:00 '테스트 돌리고 실패만 요약'` | 검증 | S |
| P7 | 거버넌스: 추가 전용 감사 로그, 발신자별 일일 쿼터(Upstash), `/정지` 킬스위치, 가족 역할 ⚠️ | now | M |

- **P1**: `lib/relay/types.ts` 에 `Channel { parseInbound, deliver }`, `Executor { id, capabilities, run? }`. 채널 kakao/telegram/discord/console/mcp/hook/cron, 실행기 antigravity/claude/llm/notify. PC heartbeat 90초 없으면 "PC 오프라인 — 큐 보관 [llm 으로 대신 답하기]".
- **P2 예시**: `@mac 명절문자 미리보기 --limit 30` → 맥에서 `send-greetings.ts`(dry-run 기본) 실행. `--send` 는 승인 필요. 인자는 정확 일치 화이트리스트(자유 argv 금지).
- **P3**: `@modelcontextprotocol/server` 의 `WebStandardStreamableHTTPServerTransport` 가 Request→Response 라 Elysia 에 맞음(stateless, JSON 응답). 도구 `relay_enqueue / relay_status / relay_notify_owner`. MCP 에서 온 작업은 기본 승인 필요(웹 콘텐츠 → 에이전트 → enqueue 인젝션 경로). 블로커: `src/app.ts` onParse 가 JSON body 를 먼저 소비 → 라우트별 우회 필요.
- **P5**: `/v2/relay/hooks/github` (X-Hub-Signature-256, X-GitHub-Delivery 를 idempotency key), 규칙 테이블 `relay_hook_rule(source, event, filter, prompt_template, requires_approval 기본 true, cooldown_sec)`. Vercel 배포 실패는 Hobby 에서 계정 웹훅이 없으므로 GitHub `repository_dispatch` 경유.
- **P6**: Supabase Free 에서 pg_cron 사용 가능. 채팅 텍스트는 파라미터로만(문자열 결합 금지). sidecar.json 손편집(WINDOW-WATCH-DOG 고장 원인)을 폰 명령으로 대체.
- **P7 가족 예시**: 미등록 발신자 → "코드 4821 을 관리자에게 전달하세요"(LLM 호출 없음) → `/허용 4821 가족 이름:수진` → 가족 역할은 질문·전달만, 셸 실행기 접근 불가. 쿼터 키는 Redis 장애 시 fail-closed.

### 5.4 대체·폴백 채널 — 카톡이 안 될 때

폴백 사다리: **0)** Remote Control PWA(이미 켜짐, 수동) → **1)** 자체 PWA 콘솔 + Web Push → **2)** 텔레그램 + 카톡 나에게 보내기 알림 → **3)** 네이버 메일 명령 채널 → **4)** Slack Socket Mode → **최후)** 가족 안드로이드 폰 경유 SMS.

| # | 채널 | 판정 | 핵심 |
|---|---|---|---|
| F1 | 자체 PWA 콘솔 "토끼 콘솔" + Web Push | **1순위 폴백** (now/M) | 카톡 제약 전부 없음, 무료로 봇이 먼저 알림. `public/console/*` 는 Vercel 이 rewrite 전에 서빙 → vercel.json 무변경. iOS 는 홈 화면 추가 후에만 푸시, 알림에 버튼 없음 |
| F2 | 텔레그램(sidecar 안 long polling) + 카톡 나에게 보내기 알림 | 강력 (now/M) ⚠️ | Vercel 불필요, 4096자, 버튼, 메시지 편집으로 진행 표시, 봇이 먼저 말함. 채팅당 초당 1건 제한 |
| F3 | 네이버 메일 명령 채널 | 가장 싼 폴백 (now/S) | 본인에게 `[봇] ...` 제목 메일 → PC 가 IMAP 보낸메일함을 20초 폴링 → 같은 스레드로 회신. `imap.naver.com:993` 응답 91ms 실측. 기존 앱 비밀번호 재사용(IMAP 동작 확인 필요). 지연 20~40초라 배치용 |
| F4 | 카톡 안에서 막히지 않게 | now/S ⚠️ | 즉시 textCard + `[콘솔에서 보기]` webLink, `결과` → `다음`/`처음` 1000자 페이징. 오픈채팅 봇은 방장봇 프리셋뿐(API 없음) → 기각 |
| F5 | Slack Socket Mode | 폴백 4순위 (now/M) | outbound WebSocket, 버튼·스레드·파일 업로드. 무료 플랜 90일 기록 → Supabase 에도 보관 |
| F6 | iOS 공유 시트 / Siri 단축어 → `/v2/relay/job` | now/S | 카톡 나와의 채팅에 쓴 글을 길게 눌러 공유 → POST. 사용자 직접 조작이라 약관 안전. 알림 읽기 자동화는 불가(본인 메시지는 알림이 안 뜸) |
| F7 | Pushbullet 양방향 | 최후 수단 (검증/M) | iOS 앱 없음. 가족 안드로이드 폰 번호로 SMS → 스트림 WebSocket 으로 PC 수신 → 문자 답장. 인터넷 없는 상황 전용. 가족 동의·프라이버시 문제 |
| — | Google Chat / LINE | 기각 | Chat API 는 Workspace 전용, LINE 은 카톡과 같은 1회용 reply token 구조 |

### 5.5 종합 — 단계별 로드맵

| 단계 | 내용 | 끝나면 되는 것 |
|---|---|---|
| **0. 안전 전제** | 훅 프로브(PreToolUse·Stop 호출 여부) → 전용 `phone-relay` 프로젝트(A1) + 읽기 전용 기본(A2) | 브리지를 켜도 원격 셸이 아님 |
| **1. 로컬 왕복** | agent-bridge sidecar + agentapi + Stop 훅 + 답변 계약(A3), `/admin/relay/enqueue` 로 E2E | 메신저 없이 서버→PC→답장 |
| **2. 카톡 MVP** | 채널 챗봇 + `/v2/relay/kakao/skill` + PC 직접 콜백(U1) + `/목록`·`/상태`(U3) + 긴 출력(U5) + 승인 카드(U2) | 카톡으로 명령·결과·승인 |
| **3. 알림·폴백** | 나에게 보내기 체인(U6) + 메일 명령 채널(F3) + 아침 요약(A6) | 봇이 먼저 알림, 카톡 장애 대비 |
| **4. 콘솔** | 웹 콘솔/PWA(P4=F1) + Web Push + 아티팩트 링크(A7) | 긴 검토·승인을 앱 수준으로 |
| **5. 플랫폼** | 멀티 세션(A4), `@claude`(A5), 기기 등록(P2), MCP(P3), 웹훅(P5), 예약(P6), 거버넌스(P7) | 어떤 채널 → 어떤 실행기든 |

---

## 6. 시작 전 결정 사항 (사용자)

1. **보안 전제**: EAGER 자동실행·샌드박스 OFF·powershell 전역 허용 상태에서 브리지 연결 여부. 브리지 전용 프로젝트 + 좁은 `agent_permissions` + 승인 단계 설계 승인.
2. **WINDOW-WATCH-DOG 수정**: `config.json` 에 `projectId` 추가 여부 (현재 매일 10:00 실행 실패 추정).
3. **기존 `chatbot-connect.ts`**: 수정해 재사용 vs 신규 `/v2/relay/kakao/skill`.
4. **`discord-logger.ts` 웹훅 토큰**: 재발급 + env 이동.
5. **로컬 Antigravity MCP 설정의 평문 자격증명**: 브리지 세션이 `.gemini` 폴더를 읽을 수 있는 현재 전역 grant 상태에서는 노출 위험 → 브리지 전에 폐기·재발급 또는 읽기 deny.
6. **U1 문법 변경 / F2 텔레그램 주 채널 / F4 카톡 webLink / P1 서버 llm 실행기 / P7 가족 역할**: 기본 설계를 바꾸는 항목이라 채택 여부 결정.
7. **A5 `@claude` 실행기**: 같은 PC 의 `claude -p` 를 브리지가 부르는 것이 사용자 CLAUDE.md 의 "NO subagents" 규칙 범위 안인지.

## 7. 검증 순서 제안

0. (로컬, 최우선) 프로브 훅: `PreToolUse`·`Stop` 핸들러가 stdin 과 시각을 파일에 남기기만 하는 훅을 걸고, agentapi 로 만든 대화와 직접 만든 대화 양쪽에서 호출되는지 확인. 훅 timeout 초과 시 allow 인지 deny 인지도 확인.
1. (사용자, 10분) business.kakao.com 일반 채널 → chatbot.kakao.com 챗봇 생성 → 채널 연결 → 폴백 블록 '...' 에 Callback 설정 보이는지.
2. (로컬, 카톡 불필요) 테스트 sidecar(`restart_policy: never`)로 `agentapi new-conversation --model flash_lite` 실행 → stdout JSON 의 conversationId 필드 확인 → Stop 훅이 transcriptPath 를 주는지 확인.
3. `send-message` 를 idle 대화에 보내 Agent Manager·Remote Control 에 보이는지, 실행 중 대화에 보내면 `queuedMessageDeliveryStrategy=NEXT_INVOCATION` 대로 큐잉되는지.
4. 스킬 URL 배포 후 x-real-ip 로그 수집 → IP 강제. callbackUrl 70초·3분 지연 POST 로 유효시간 실측. 27MB 번들 cold start(측정 1.73초) 가 5초 안에 드는지 p95 확인.

## 8. 미확인 사항 (Open)

- `agentapi new-conversation` 성공 stdout 의 conversationId 필드명 (실패 응답만 확인됨).
- 워크스페이스 `.agents/hooks.json` 이 sidecar 생성 대화에도 적용되는지, Stop 이 턴마다 1회인지.
- `agent_permissions` 가 command sidecar 에도 적용되는지, 승인 필요 도구가 자동 거부인지 Remote Control 에서 승인 가능한지.
- sidecar 가 메인 창 닫힘·트레이·자동 업데이트(2026-10-08 language_server.exe 교체됨) 후에도 유지되는지.
- Windows 절전·재개 후 supabase-js Realtime 재연결.
- Remote Control 계정 플래그 실제 활성 여부 (설정은 ON, 대시보드 미테스트).
- 카카오: 미인증 채널 배포, Callback 토글 즉시 활성, callbackUrl 1분/5분, 콜백 월 쿼터(영상 언급 10만, UNVERIFIED).
