# 토키 위젯(Tokki Widget) 및 백엔드 서버 일일 부하 테스트 · 적대적 보안 점검 보고서

- **감사 문서 ID**: `AUDIT-TOKKI-DAILY-20261120`
- **세션명**: `[세션명: 토키 위젯 일일 부하 테스트]`
- **문서 버전**: `v6.8.0-DAILY-KO`
- **점검 일시**: 2026년 11월 20일 03:18 KST (`2026-11-20T03:18:00+09:00`)
- **점검 대상**:
  - 백엔드 (`my-server-test`): `/Users/user/src/my-server-test` (`https://my-server-mocha.vercel.app`, Node `v24.22.3` / `iad1` / `commitSha: cb5f128` 활성 확인)
  - 프런트엔드 (`tokki-widget`): `/Users/user/src/tokki-widget`
- **실행 모드**: 단일 에이전트 집중 점검 (`development` 무결성 모드 — 멀티 에이전트 스웜 미사용, 외부 클라우드 유·무료 쿼터 부하 `0`)
- **최종 판정**: **전 항목 통과 (100% PASS — 신규 적발된 타르핏 오류 응답 교착·Redis 복구 시 파산 키 부활·CORS `text/plain` 우회·종단 503 재시도 폭풍·호스트 DOM 초점 탈취 취약점 4건 즉시 패치 및 영구 회귀 테스트 반영 완료)**

---

## 1. 핵심 요약 (Executive Summary)

본 일일 정기 점검은 외부 제3자 클라우드 무료 플랜 한도(Vercel Serverless Fluid Active CPU·일일 배포 횟수, Supabase DB, OpenRouter 크레딧)를 보호하기 위해 로컬 허메틱(Hermetic) 실전 HTTP 서버(`Bun.serve` + `createApp(true)`)와 실제 `/usr/bin/curl` 프로세스를 사용하여 수행되었다(라이브 프로덕션 `my-server-mocha.vercel.app`에는 무부하 단일 헬스체크 GET 2회만 수행).

1. **[R1] 제어된 경량 동시성 제어 및 HTTP 429/402/타르핏(Tarpit) 페일오버 방어 검증 (`api_key_rotation_plan.md` 준수)**:
   - 5개 API 키·4개 계정 풀(`acc-bankrupt` 파산 계정 2개 형제 키 [Mock `402`], `acc-ratelim-1` 속도 제한 [Mock `429 Retry-After: 15`], `acc-ratelim-2` 속도 제한 [Mock `429 Retry-After: HTTP-date +18s`], `acc-healthy` 정상 계정 [Mock `200` 멀티청크 SSE])을 대상으로 **1차 콜드 페일오버 버스트 동시 18건(정상 SSE 완주 16건 + 스트리밍 도중 클라이언트 강제 연결 종료 2건)** 및 **2차 웜 스테디스테이트 동시 12건**을 실행했다.
   - **1차 콜드 페일오버 버스트(18건)** 총 소요 시간 **`80.41 ms`**(`Min: 71.10 ms`, `p50: 73.05 ms`, `p95/Max: 79.57 ms`), **2차 웜 스테디스테이트(12건)** 총 소요 시간 **`71.58 ms`**(`Min: 68.72 ms`, `p50: 69.80 ms`, `p95/Max: 71.20 ms`)로 서버리스 타임아웃(`60,000 ms`)의 **0.14% 이내**에 교착 상태(Deadlock) 없이 **100% 페일오버 완주**를 달성했다.
   - `k1-dead-a`에서 최초 `HTTP 402`가 감지된 즉시 동일 계정(`acc-bankrupt`) 소속 형제 키 `k2-dead-b`는 **업스트림 호출 `0건`**으로 즉시 파산(`EXHAUSTED`) 격리되었으며, 2차 웨이브 12건에서는 파산·쿨다운 상태의 불량 키(1~4번 키) 호출이 **`0건`**으로 완벽히 차단되었다. 모든 스트림 완주, 강제 중단(`499`), 타르핏 오류 응답 타임아웃 직후 전 키의 ZSET 활성 리스 수(`inFlightRequests`)는 **`ZCARD = 0`**으로 전량 회수되어 세마포어·메모리 누수가 없음을 입증했다.
2. **[R2] 프런트엔드-백엔드 적대적 보안 감사 및 즉시 패치 (4건 신규 보강)**:
   - 미등록/누락/SQLi/초장문/`message` 누락/CORS Simple Request(`text/plain`) `widgetId` 변조 요청이 `/v2/ask` 및 `/v2/widget/create-thread`에서 **100% `HTTP 403 Forbidden`**으로 차단되고, `4,000자` 초과 메시지·CORS `text/plain` 토큰 폭탄·비문자열 `message`/`create-thread` `widgetId` 중첩 객체 밀수·`2,000자` 초과 보조 필드(`browserInfo`, `threadId`, `search`, `/v2/widget/view` `threadId`)·`1MB`(업로드 `2MB`) 초과 스트리밍 본문이 **100% `HTTP 413 Payload Too Large`**로 차단됨을 **24개 실전 `/usr/bin/curl` 벡터 전량 통과(`24/24 PASS`)**로 입증했다.
   - 심층 보안·동시성 코드 감사에서 적발된 **4건의 신규 취약점 및 페일오버 결함**(① 업스트림 `429`/`502` 헤더 수신 직후 오류 바디 스트림이 정체(Tarpit)될 때 `cleanupSignal()` 조기 해제로 인한 `60s` 서버리스 교착 및 `response.clone()` 미소비 `ReadableStream` 분기 메모리 누수 + Upstash 장애 복구 시 파산 `402` 키 부활 결함 + 단일 키 프로바이더 유휴 청크 워치독 부재, ② CORS Simple Request[`Content-Type: text/plain`] 및 비객체 JSON[`null`/`Array`] 전송 시 `422` TypeBox 내부 스키마 노출 우회 및 `/v2/widget/create-thread` 초장문 객체 `413` 미적용 + Supabase 일시 장애 시 현재 사용자 질문 누락 결함, ③ 프런트엔드 전 계정 `402` 고갈[`503 ALL_ACCOUNTS_EXHAUSTED`]·모델 장애 시 맹목적 재시도 폭풍 차단 및 `llmApi.reply` `credentials: "include"`·`4,000자` 상한·비정상 응답 `blob:` 누수 차단, ④ `MarkdownPreview.tsx` `tabIndex` 호스트 초점 탈취·상대 경로 `target="_top"` 창 하이재킹·초대형 `width`/`height` 레이아웃 DoS 차단 및 `ChatWindow.tsx` 역탭내빙·청소하기 DOM 잔류 텍스트 초기화·`ContactModal.tsx` `#fff` `NaN` CSS 방어)을 **즉시 전량 패치**했다.
3. **[R3] 자동화 무결성 검증 및 프리플라이트 빌드·쿼터 보호**:
   - 백엔드 `bun test` **325 / 325 PASS** (`2,092` assertions) + 프런트엔드 `bun test` **41 / 41 PASS** (`219` assertions) = **총 366 / 366 테스트 100% 통과 (`2,311` expect 단언문, 종료 코드 `0`)**.
   - 사전 빌드(`npm run bundle:api` → `api/index.js` `27.0MB`, `npm run type-check`, `npm run build`, `npm run build:embed`, `npm run export-playground`) 전량 무오류 통과 및 `[skip ci]` 로컬 커밋 규칙을 준수했다.

---

## 2. R1: 경량 동시성 제어 및 429/402/타르핏 페일오버 방어 실측 결과

### 2.1 테스트 토폴로지 (5-Key / 4-Account ZSET 세마포어 풀)

| 키 ID | 소속 계정 (`accountId`) | 티어 / 가중치 | 오류 주입 시나리오 | 1차 웨이브 호출 수 | 2차 웨이브 호출 수 | 종료 후 상태 / 서킷 | 최종 `ZCARD` (`inFlightRequests`) |
| :--- | :--- | :---: | :--- | :---: | :---: | :--- | :---: |
| `k1-dead-a` | `acc-bankrupt` | Tier 0 / `100` | Mock `HTTP 402` (계정 지갑 크레딧 고갈) | `1회` | **`0회`** | `EXHAUSTED` / `OPEN` | **`0`** |
| `k2-dead-b` | `acc-bankrupt` (형제 키) | Tier 0 / `95` | 동일 계정 파산 즉시 전파 대상 | **`0회`** (Fast-Break) | **`0회`** | `EXHAUSTED` / `OPEN` | **`0`** |
| `k3-rl-delta` | `acc-ratelim-1` | Tier 0 / `85` | Mock `HTTP 429` (`Retry-After: 15`) | `1회` | **`0회`** | `RATE_LIMITED` / `OPEN` | **`0`** |
| `k4-rl-date` | `acc-ratelim-2` | Tier 0 / `75` | Mock `HTTP 429` (`Retry-After: HTTP-date +18s`) | `1회` | **`0회`** | `RATE_LIMITED` / `OPEN` | **`0`** |
| `k5-healthy` | `acc-healthy` | Tier 1 / `60` | 정상 `HTTP 200` 4청크 SSE 스트리밍 | `18회` (완주 16 + 중단 2) | **`12회`** | `ACTIVE` / `CLOSED` | **`0`** |

### 2.2 동시 요청 지연시간(Latency) · 페일오버 · 리소스 회수 지표

| 측정 항목 | 1차 콜드 페일오버 버스트 (동시 18건: 완주 16 + 중단 2) | 2차 웜 스테디스테이트 (동시 12건) | 허용 기준 (SLA) | 판정 |
| :--- | :---: | :---: | :---: | :---: |
| **총 동시 실행 Wall-Clock 시간** | **`80.41 ms`** | **`71.58 ms`** | `< 60,000 ms` (서버리스 타임아웃) | **PASS** |
| **정상 SSE 완주 성공률** | **`16 / 16 (100%)`** | **`12 / 12 (100%)`** | `100%` (`data: [DONE]` 확인) | **PASS** |
| **지연시간 분포 (`Min / p50 / p95 / Max`)** | `71.10 / 73.05 / 79.57 / 79.57 ms` | `68.72 / 69.80 / 71.20 / 71.20 ms` | 무교착 · 일관된 응답성 | **PASS** |
| **스트리밍 중 클라이언트 강제 중단 (`499`)** | `2 / 2` 즉시 `cancel()` 및 리스 반납 | — | 좀비 세마포어 리스 `0건` | **PASS** |
| **형제 파산 키(`k2-dead-b`) 낭비 호출** | **`0 건`** (`acc-bankrupt` 계정 단위 즉시 차단) | **`0 건`** | 계정 단위 Fast-Break 작동 | **PASS** |
| **타르핏 오류 바디 타임아웃 & Upstash `402` 복구 동기화** | `502` 바디 정체 시 `perAttemptTimeoutMs` 내 즉시 페일오버 + Redis 복구 시 파산 계정 즉시 재동기화 | — | 교착 `0건` · `ZCARD = 0` | **PASS** |
| **종료 후 ZSET 활성 리스 합계 (`ZCARD`)** | **`0`** | **`0`** | 정확히 `0` (Zero Leak) | **PASS** |
| **미등록 요청 시 고아 스레드 생성 수** | **`0 건`** | **`0 건`** | DB 오염 `0건` | **PASS** |

> **프로덕션 라이브 헬스체크 (무부하 단일 GET 2회)**:
> - `GET https://my-server-mocha.vercel.app/v1/healthz` → `HTTP 200` (`"OK"`, 콜드 응답 `2,350.34 ms`)
> - `GET https://my-server-mocha.vercel.app/v1/heartbeat` → `HTTP 200` (`{"status":"alive","node":"v24.22.3","region":"iad1","commitSha":"cb5f128"}`, 웜 응답 `289.43 ms`)

---

## 3. R2: 적대적 보안 감사 결과 및 즉시 패치 내역

### 3.1 금일(2026-11-20) 적발 즉시 패치한 페일오버·방어선·프런트엔드 보안 취약점 (4건)

1. **[중대] 업스트림 비정상 응답 타르핏(Tarpit) 교착·`response.clone()` 스트림 누수 차단 및 Upstash 장애 복구 시 파산(`402`) 키 부활 방지 (`my-server-test/lib/llm/key-manager/executor.ts`, `stores/upstash-redis.ts`, `lib/llm/openai-compatible.ts`)**
   - **원인**: `executor.ts`에서 업스트림 HTTP 헤더 수신 직후 `cleanupSignal()`로 `perAttemptTimeoutMs` 타이머를 해제한 뒤 `response.clone().json()`과 `response.text()`를 호출하고 있었다. 업스트림 게이트웨이가 `502`/`429` 헤더만 반환하고 본문 스트림을 닫지 않는 타르핏 장애 시 `60s` 서버리스 강제 종료까지 교착되며, `response.clone()`으로 분기(tee)된 원본 스트림이 취소되지 않아 매 `402`/`429` 회전마다 버퍼가 누수되었다. 또한 `UpstashRedisKeyStore`가 스토리지 서킷 브레이커 개방(Fail-Open) 중 발생한 `402` 영구 파산 상태를 브레이커 복구 후 Redis에 역동기화하지 않아 파산 계정이 다시 선택될 수 있었고, 단일 키 `OpenAICompatibleProvider`에는 청크 유휴 워치독이 없었다.
   - **패치**: `readBoundedErrorBody(response, 8192, attemptSignal)` 단일 패스 리더를 도입해 `8KB` 상한 및 `attemptSignal` 데드라인 안에서 오류 본문을 읽고 즉시 스트림을 취소하도록 수정했으며, `200 OK` 핸드셰이크 직후 클라이언트 취소 시 리스를 즉시 회수하도록 보강했다. `UpstashRedisKeyStore`에는 `pendingPermanentExhaustions` 큐를 추가해 Redis 복구 시 파산 키와 `broken` 계정 플래그를 선반영하도록 했고, `OpenAICompatibleProvider`에도 `chunkTimeoutMs`(기본 `25,000ms`) 유휴 스톨 워치독과 `8KB`/타임아웃 `safeText` 리더를 적용했다.
2. **백엔드 CORS Simple Request(`text/plain`)·비객체 본문 `422` 스키마 노출 차단, `/v2/widget/create-thread` `413` 가드 및 DB 장애 시 질문 유실 방지 (`my-server-test/src/endpoints/v2/widget-endpoints.ts`)**
   - **원인**: `/v2/ask`, `/v2/widget/create-thread`, `/v2/widget/view`가 `t.Object(...)` 루트 스키마에 의존하여 브라우저 프리플라이트를 우회하는 `Content-Type: text/plain` 요청이 유입될 때 `403`/`413` 대신 TypeBox 내부 스키마 JSON을 담은 `422`를 반환했고, `/v2/widget/create-thread`에 초장문 `widgetId` 객체(`>4,000자`) `413` 가드가 없었으며, Supabase 일시 장애로 `createThread`나 `listMessages`가 빈 결과를 반환할 때 LLM 요청 `messages`에서 현재 `userMessage`가 누락되는 결함이 있었다.
   - **패치**: 세 엔드포인트 모두 핸들러 내부에서 루트 타입 및 직렬화 길이를 직접 검증하여 초과 본문은 즉시 `HTTP 413`, 비객체/미등록 요청은 스키마 노출 없이 `HTTP 403`(`view`는 `400`/`200`)으로 일관 차단하도록 패치했고, DB 저하 시에도 현재 `userMessage`가 `boundedHistory` 마지막 턴에 항상 포함되도록 보장했다.
3. **프런트엔드 종단 서킷(`503 ALL_ACCOUNTS_EXHAUSTED` 등) 재시도 폭풍 억제, 음성 질문 입력창 오염 수정 및 `llmApi.reply()` 보안 보강 (`tokki-widget/lib/state/chat.tsx`, `lib/api/llm.ts`)**
   - **원인**: `chat.tsx`가 `4xx` 코드만 재시도 억제 대상으로 판별하여, 백엔드가 모든 키 `402` 파산(`ALL_ACCOUNTS_EXHAUSTED`), 모델 장애(`UPSTREAM_MODEL_OUTAGE`), 5키 회전 소진(`FAILOVER_EXHAUSTED`)으로 `HTTP 503`/`502`를 반환할 때 클라이언트가 맹목적으로 즉시 재요청을 발사해 서버리스 호출과 중복 사용자 메시지 적재를 2배로 증폭시켰다. 또한 `startVoiceQuestion` 완료 시 봇 답변 전체를 `chatState.inputText`에 덮어써 장문 답변 이후 전송 불능을 유발했고, `llmApi.reply()`는 `credentials: "include"`·입력 길이 제한·`!res.ok` 검증이 누락되어 오류 JSON을 `URL.createObjectURL`로 누수시켰다.
   - **패치**: `error.clone().json()`으로 종단 게이트웨이 코드(`ALL_ACCOUNTS_EXHAUSTED`, `UPSTREAM_MODEL_OUTAGE`, `FAILOVER_EXHAUSTED`, `UPSTREAM_CLIENT_ERROR`) 감지 시 재시도를 즉시 억제하되 일반 일시적 `502`/`504` 네트워크 오류에는 단일 재시도를 유지했으며, `startVoiceQuestion`의 입력창 덮어쓰기를 제거하고 `llmApi.reply()`에 `credentials: "include"`, `4,000자` 절삭 및 `!res.ok` 예외 처리를 적용했다.
4. **프런트엔드 호스트 DOM 초점 탈취(`tabIndex`)·상대 링크 `target="_top"`·초대형 이미지 DoS 차단 및 역탭내빙·청소하기 DOM 동기화 (`tokki-widget/lib/components/MarkdownPreview.tsx`, `ChatWindow.tsx`, `ContactModal.tsx`)**
   - **원인**: 호스트 웹페이지 DOM 내부에 직접 마운트되는 위젯 특성상 `MarkdownPreview.tsx`의 `SAFE_HAST_PROPS`에 허용된 `tabIndex`가 호스트 페이지 키보드 초점 순서를 하이재킹할 수 있었고, 상대/해시 링크에서 `target="_top"`이 유지되거나 `width="999999"` 이미지가 레이아웃 DoS를 유발할 수 있었다. 또한 `ChatWindow.tsx`의 로고 `window.open`에 `noopener,noreferrer`가 없었고 비제어 `<textarea>`가 청소하기 클릭 후에도 기존 입력 문자열을 DOM에 남겼으며, `ContactModal.tsx`의 `hexToRgba("#fff")`가 `rgba(255, 15, NaN, 0.3)`를 생성했다.
   - **패치**: `SAFE_HAST_PROPS`에서 `tabIndex`를 제거하고 비외부 링크의 `target` 속성을 삭제하며 숫자형 `width`/`height`를 `1..1000`으로 클램핑했다. 아울러 `window.open`에 `"noopener,noreferrer"`를 추가하고 청소하기 실행 시 `inputTextRef.current.value = ""`로 즉시 초기화하며, `ContactModal.tsx`에 3자리/6자리/비정상 색상값을 안전 정규화하는 `parseSafeHexRgb()`를 적용했다.

### 3.2 실시간 `/usr/bin/curl` 적대적 보안 경계 검증 로그 (24개 공격·경계 벡터 전량 통과)

| 벡터 ID | 실측 공격·경계 시나리오 (`/usr/bin/curl`) | 기대 상태 | 실측 상태 | 응답 본문 요약 | 소요 시간 | 판정 |
| :---: | :--- | :---: | :---: | :--- | :---: | :---: |
| `V01` | `POST /v2/ask` — `widgetId` 필드 누락 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `9.33 ms` | **PASS** |
| `V02` | `POST /v2/ask` — 미등록 `widgetId` 변조 (`"evil-spoof-widget-999"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.66 ms` | **PASS** |
| `V03` | `POST /v2/ask` — SQL 인젝션 `widgetId` (`"' OR '1'='1"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.60 ms` | **PASS** |
| `V04` | `POST /v2/ask` — 초장문 `widgetId` (500자, DB 무조회 즉시 차단) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.84 ms` | **PASS** |
| `V05` | `POST /v2/ask` — 미등록 `widgetId` + `message` 누락 (`422` 스키마 노출 없이 `403`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.68 ms` | **PASS** |
| `V06` | `POST /v2/ask` — CORS Simple Request (`text/plain`) 우회 프로브 차단 (신규 패치) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.50 ms` | **PASS** |
| `V07` | `POST /v2/widget/create-thread` — 미등록 `widgetId` 스레드 발급 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id"}` | `5.80 ms` | **PASS** |
| `V08` | `POST /v2/widget/create-thread` — 중첩 객체 `widgetId` `4,500자` 폭탄 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"widgetId too large (4511 > 4000 chars)"}` | `5.06 ms` | **PASS** |
| `V09` | `POST /v2/ask` — 정상 최대 경계값 `message` 정확히 `4,000자` | `200` | **`200`** | `data: 토키%20 ... data: [DONE]` (정상 SSE 스트리밍) | `60.62 ms` | **PASS** |
| `V10` | `POST /v2/ask` — 경계 초과 `message` `4,001자` | `413` | **`413`** | `{"success":false,"error":"message too long (4001 > 4000 chars)"}` | `7.21 ms` | **PASS** |
| `V11` | `POST /v2/ask` — `50,000자` 한글 토큰 폭탄 (Token Bomb) | `413` | **`413`** | `{"success":false,"error":"message too long (50000 > 4000 chars)"}` | `6.29 ms` | **PASS** |
| `V12` | `POST /v2/ask` — CORS `text/plain` `4,500자` 토큰 폭탄 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"message too long (4500 > 4000 chars)"}` | `6.06 ms` | **PASS** |
| `V13` | `POST /v2/ask` — 비문자열 `message` 중첩 객체 밀수 (`4,500자`) | `413` | **`413`** | `{"success":false,"error":"message too long (4511 > 4000 chars)"}` | `5.42 ms` | **PASS** |
| `V14` | `POST /v2/ask` — `browserInfo` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"browserInfo too large (2508 > 2000 chars)"}` | `5.15 ms` | **PASS** |
| `V15` | `POST /v2/ask` — `threadId` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2500 > 2000 chars)"}` | `5.85 ms` | **PASS** |
| `V16` | `POST /v2/ask` — `search` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"search options too large (2500 > 2000 chars)"}` | `5.16 ms` | **PASS** |
| `V17` | `POST /v2/widget/view` — `threadId` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2500 > 2000 chars)"}` | `5.37 ms` | **PASS** |
| `V18` | `POST /v2/ask` — `Content-Length > 1MB` (`1.15MB` 바디 선차단) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.86 ms` | **PASS** |
| `V19` | `POST /v2/ask` — Chunked + `APPLICATION/JSON ; charset=utf-8` `1.15MB` 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `6.00 ms` | **PASS** |
| `V20` | `POST /v2/ask` — 상충 복수 `Content-Length: 10, 2097152` 스머글링 차단 (RFC 9112) | `400` / `413` | **`400`** | 소켓 HTTP 파서 계층 `400` 즉시 차단 + 프록시 정규화 시 `onRequest` `413` 이중 방어 | `4.64 ms` | **PASS** |
| `V21` | `POST /v2/admin/widgets/upload-icon` — Chunked `2.35MB` 멀티파트 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 2MB limit"}` | `7.66 ms` | **PASS** |
| `V22` | `POST /v2/admin/widgets/upsert` — 전체화면 클릭재킹 `chat_bubble_size` (`"100vw"`) 차단 | `400` | **`400`** | `{"success":false,"error":"invalid chat_bubble_size (must be a safe CSS size like '48px' or '3.5rem')"}` | `6.52 ms` | **PASS** |
| `V23` | `POST /v2/widget/view` — `widgetId: null, threadId: null` 고아 스레드 무생성 검증 | `200` | **`200`** | `{"success":true,"thread_id":"",...}` (DB 고아 스레드 생성 `0건`) | `4.64 ms` | **PASS** |
| `V24` | `POST /v2/ask` — 동일 IP 분당 10회 초과 폭주 방어 (11번째 요청) | `429` | **`429`** | `{"success":false,"error":"Too Many Requests",...,"retryAfter":60}` | `4.49 ms` | **PASS** |

---

## 4. R3: 자동화 무결성 검증 및 프리플라이트 빌드 결과

### 4.1 테스트 스위트 실행 결과 (`bun test`)

| 저장소 | 테스트 파일 수 | 통과 / 실패 | `expect()` 단언문 수 | 실행 시간 | 종료 코드 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`my-server-test` (백엔드)** | 13개 파일 | **`325 PASS / 0 FAIL`** | `2,092`개 | `7.10s` | `0` |
| **`tokki-widget` (프런트엔드)** | 2개 파일 | **`41 PASS / 0 FAIL`** | `219`개 | `0.22s` | `0` |
| **합계** | **15개 파일** | **`366 PASS / 0 FAIL` (100%)** | **`2,311`개** | **`7.32s`** | **`0`** |

### 4.2 로컬 프리플라이트 빌드 검증

- **백엔드 번들 동기화 (`my-server-test`)**:
  - `npm run bundle:api` → 7개 SQL 마이그레이션 인라인(`src/generated-migrations.ts`) 및 단일 서버리스 번들 `api/index.js` (`27.0MB`, Node 24 CJS) 빌드 성공 (`116ms`).
  - Node.js CJS 핸들러 스모크 검증 (`require("./api/index.js").default` → `GET /v1/healthz`) → `HTTP 200 OK` 정상 반환 확인.
- **프런트엔드 타입체크 및 프로덕션 번들 빌드 (`tokki-widget`)**:
  - `npm run type-check` (`tsc`) → 타입 오류 `0건`.
  - `npm run build` (라이브러리 빌드 + `.d.ts` 생성) → `dist/` 정상 생성 (`2.67s`).
  - `npm run build:embed` (임베드 단일 스크립트 빌드) → `dist-embed/tokki.js` 및 `public/embed/tokki.js` (`2,139.01 kB` / gzip `626.30 kB`) 동기화 완료 (`2.04s`).
  - `npm run export-playground` (플레이그라운드 번들 빌드) → `export-playground/main.js` 정상 생성 (`2.46s`).

---

## 5. 수락 기준(Acceptance Criteria) 최종 점검표

- [x] **[성능 및 방어 무결성]** 제어된 동시 요청(18건 + 12건) 및 HTTP 429/402/타르핏 오류 주입 환경에서 교착 상태나 메모리·세마포어 누수(`ZCARD = 0`) 없이 **100% 페일오버**를 달성했는가? → **달성 완료 (`80.41 ms` / `71.58 ms`, 완주율 100%, 파산 형제 키 호출 `0건`, 타르핏 오류 본문 타임아웃 페일오버 및 Upstash `402` 복구 동기화 검증 완료, `ZCARD = 0`)**
- [x] **[보안 경계 입증]** 악의적 `widgetId` 변조(`HTTP 403`) 및 초대형 페이로드·토큰 폭탄 공격(`HTTP 413`) 차단이 실측 로그로 입증되었는가? → **24개 실전 `curl` 벡터 전량 통과(`24/24 PASS`) 및 4건의 신규 페일오버·방어선·클라이언트 보안 취약점 즉시 패치 완료**
- [x] **[최종 산출물]** 한국어 감사 보고서(`stress_test_audit.md`)가 생성되었는가? → **양쪽 워크스페이스(`my-server-test`, `tokki-widget`)에 한국어로 생성 완료**
- [x] **[테스트 무결성]** 모든 방어 테스트(`bun test`)가 종료 코드 `0`으로 100% 통과했는가? → **`366 / 366 PASS` (`2,311` assertions, `Exit Code 0`)**
- [x] **[쿼터 보호]** 커밋 메시지에 `[skip ci]`가 포함되어 Vercel 및 GitHub Actions 무료 쿼터를 보호했는가? → **`fix(tokki): automated defense and load test patch [skip ci]` 로컬 커밋 적용 완료 (무료 배포 쿼터 보호를 위해 불필요한 원격 푸시 생략)**
