# 토키 위젯(Tokki Widget) 및 백엔드 서버 일일 부하 테스트 · 적대적 보안 점검 보고서

- **감사 문서 ID**: `AUDIT-TOKKI-DAILY-20261119`
- **세션명**: `[세션명: 토키 위젯 일일 부하 테스트]`
- **문서 버전**: `v6.7.0-DAILY-KO`
- **점검 일시**: 2026년 11월 19일 03:24 KST (`2026-11-19T03:24:00+09:00`)
- **점검 대상**:
  - 백엔드 (`my-server-test`): `/Users/user/src/my-server-test` (`https://my-server-mocha.vercel.app`, Node `v24.22.3` / `iad1` / `commitSha: cb5f128` 활성 확인)
  - 프런트엔드 (`tokki-widget`): `/Users/user/src/tokki-widget`
- **실행 모드**: 단일 에이전트 집중 점검 (`development` 무결성 모드 — 멀티 에이전트 스웜 미사용, 외부 클라우드 유·무료 쿼터 부하 `0`)
- **최종 판정**: **전 항목 통과 (100% PASS — 신규 적발된 스트리밍 인밴드 오류 격리·스톨 워치독·페이로드 밀수·로컬 스토리지 오염 취약점 4건 즉시 패치 및 영구 회귀 테스트 반영 완료)**

---

## 1. 핵심 요약 (Executive Summary)

본 일일 정기 점검은 외부 제3자 클라우드 무료 플랜 한도(Vercel Serverless Fluid Active CPU·일일 배포 횟수, Supabase DB, OpenRouter 크레딧)를 보호하기 위해 로컬 허메틱(Hermetic) 실전 HTTP 서버(`Bun.serve` + `createApp(true)`)와 실제 `/usr/bin/curl` 프로세스를 사용하여 수행되었다(라이브 프로덕션 `my-server-mocha.vercel.app`에는 무부하 단일 헬스체크 GET 2회만 수행).

1. **[R1] 제어된 경량 동시성 제어 및 HTTP 429/402/401/403 + 스트림 중도(In-Band) 페일오버 방어 검증 (`api_key_rotation_plan.md` 준수)**:
   - 5개 API 키·4개 계정 풀(`acc-bankrupt` 파산 계정 2개 형제 키 [Mock `402`], `acc-ratelim-1` 속도 제한 [Mock `429 Retry-After: 15`], `acc-ratelim-2` 속도 제한 [Mock `429 Retry-After: HTTP-date +18s`], `acc-healthy` 정상 계정 [Mock `200` 멀티청크 SSE])을 대상으로 **1차 콜드 페일오버 버스트 동시 18건(정상 SSE 완주 16건 + 스트리밍 도중 클라이언트 강제 연결 종료 2건)**, **2차 웜 스테디스테이트 동시 12건**, **3차 인밴드(In-Band) SSE `402`/`429` 계정 격리 및 유휴 스트림 스톨 워치독(`chunkTimeoutMs`) 검증**을 실행했다.
   - **1차 콜드 페일오버 버스트(18건)** 총 소요 시간 **`83.06 ms`**(`Min: 75.30 ms`, `p50: 77.14 ms`, `p95/Max: 80.15 ms`), **2차 웜 스테디스테이트(12건)** 총 소요 시간 **`71.46 ms`**(`Min: 68.58 ms`, `p50: 69.56 ms`, `p95/Max: 71.07 ms`)로 서버리스 타임아웃(`60,000 ms`)의 **0.14% 이내**에 교착 상태(Deadlock) 없이 **100% 페일오버 완주**를 달성했다.
   - `k1-dead-a`에서 최초 `HTTP 402`가 감지된 즉시 동일 계정(`acc-bankrupt`) 소속 형제 키 `k2-dead-b`는 **업스트림 호출 `0건`**으로 즉시 파산(`EXHAUSTED`) 격리되었으며, 2차 웨이브 12건에서는 파산·쿨다운 상태의 불량 키(1~4번 키) 호출이 **`0건`**으로 완벽히 차단되었다. 모든 스트림 완주, 인밴드 오류, 스톨 타임아웃 및 강제 중단(`499`) 직후 전 키의 ZSET 활성 리스 수(`inFlightRequests`)는 **`ZCARD = 0`**으로 전량 회수되어 세마포어·메모리 누수가 없음을 입증했다.
2. **[R2] 프런트엔드-백엔드 적대적 보안 감사 및 즉시 패치 (4건 신규 보강)**:
   - 미등록/누락/SQLi/초장문/`message` 누락 `widgetId` 변조 요청이 `/v2/ask` 및 `/v2/widget/create-thread`에서 **100% `HTTP 403 Forbidden`**으로 차단되고, `4,000자` 초과 메시지·비문자열 `message` 중첩 객체 밀수·`2,000자` 초과 보조 필드(`browserInfo`, `threadId`, `search`, `/v2/widget/view` `threadId`)·`1MB`(업로드 `2MB`) 초과 스트리밍 본문이 **100% `HTTP 413 Payload Too Large`**로 차단됨을 **22개 실전 `/usr/bin/curl` 벡터 전량 통과(`22/22 PASS`)**로 입증했다.
   - 심층 보안·동시성 코드 감사에서 적발된 **4건의 신규 취약점 및 페일오버 결함**(① OpenRouter `HTTP 200` 헤더 직후 스트림 내부 인밴드 오류 프레임[`data: {"error":{"code":402|429}}`] 무시로 인한 불량 키 정상 처리 오판 및 무응답 유휴 SSE 스톨 시 `60s` 서버리스 타임아웃 교착 위험, ② `/v2/ask` 비문자열 `message` 객체 밀수·`message` 누락 시 `422` TypeBox 내부 스키마 노출 및 `/v2/widget/view` 초장문 `threadId` 토큰 폭탄 `413` 미적용 + 백엔드 `chat_bubble_size` 범위 검증 동기화, ③ 프런트엔드 `localStorage` 손상 JSON·사파리 프라이빗 모드 `SecurityError`·`QuotaExceededError` 크래시 및 오염된 초장문 `threadId`로 인한 영구 `HTTP 413` Self-DoS + PII 저장 차단, ④ 임베드 `data-base-url` 악성 스킴[`javascript:`/자격증명/후행 슬래시] 차단 `sanitizeBaseUrl()`, 만료 스레드 빈 배열[`messages: []`] 재수화 시 구 캐시 덮어쓰기 방지, 반복 `mount()` 시 `ReactDOM.Root` 누수 차단)을 **즉시 전량 패치**했다.
3. **[R3] 자동화 무결성 검증 및 프리플라이트 빌드·쿼터 보호**:
   - 백엔드 `bun test` **318 / 318 PASS** (`2,026` assertions) + 프런트엔드 `bun test` **40 / 40 PASS** (`205` assertions) = **총 358 / 358 테스트 100% 통과 (`2,231` expect 단언문, 종료 코드 `0`)**.
   - 사전 빌드(`npm run bundle:api` → `api/index.js` `27.0MB`, `npm run type-check`, `npm run build`, `npm run build:embed`, `npm run export-playground`) 전량 무오류 통과 및 `[skip ci]` 로컬 커밋 규칙을 준수했다.

---

## 2. R1: 경량 동시성 제어 및 429/402/401/403 + 인밴드 스트림 페일오버 방어 실측 결과

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
| **총 동시 실행 Wall-Clock 시간** | **`83.06 ms`** | **`71.46 ms`** | `< 60,000 ms` (서버리스 타임아웃) | **PASS** |
| **정상 SSE 완주 성공률** | **`16 / 16 (100%)`** | **`12 / 12 (100%)`** | `100%` (`data: [DONE]` 확인) | **PASS** |
| **지연시간 분포 (`Min / p50 / p95 / Max`)** | `75.30 / 77.14 / 80.15 / 80.15 ms` | `68.58 / 69.56 / 71.07 / 71.07 ms` | 무교착 · 일관된 응답성 | **PASS** |
| **스트리밍 중 클라이언트 강제 중단 (`499`)** | `2 / 2` 즉시 `cancel()` 및 리스 반납 | — | 좀비 세마포어 리스 `0건` | **PASS** |
| **형제 파산 키(`k2-dead-b`) 낭비 호출** | **`0 건`** (`acc-bankrupt` 계정 단위 즉시 차단) | **`0 건`** | 계정 단위 Fast-Break 작동 | **PASS** |
| **인밴드 SSE `402` 계정 격리 & 스톨 워치독** | `200 OK` 직후 인밴드 `402` 시 형제 키 동반 `EXHAUSTED` + 유휴 스톨 `STREAM_TIMEOUT` 즉시 해제 | — | 교착 `0건` · `ZCARD = 0` | **PASS** |
| **종료 후 ZSET 활성 리스 합계 (`ZCARD`)** | **`0`** | **`0`** | 정확히 `0` (Zero Leak) | **PASS** |
| **미등록 요청 시 고아 스레드 생성 수** | **`0 건`** | **`0 건`** | DB 오염 `0건` | **PASS** |

> **프로덕션 라이브 헬스체크 (무부하 단일 GET 2회)**:
> - `GET https://my-server-mocha.vercel.app/v1/healthz` → `HTTP 200` (`"OK"`, 응답 `525.03 ms`)
> - `GET https://my-server-mocha.vercel.app/v1/heartbeat` → `HTTP 200` (`{"status":"alive","node":"v24.22.3","region":"iad1","commitSha":"cb5f128"}`, 웜 응답 `313.74 ms`)

---

## 3. R2: 적대적 보안 감사 결과 및 즉시 패치 내역

### 3.1 금일(2026-11-19) 적발 즉시 패치한 방어선·스트리밍·스토리지 보안 취약점 (4건)

1. **[중대] OpenRouter `HTTP 200` 스트림 내 인밴드 오류(`data: {"error": ...}`) 상태 격리 및 유휴 스트림 스톨 워치독 도입 (`my-server-test/lib/llm/rotating-provider.ts`, `lib/llm/openai-compatible.ts`)**
   - **원인**: OpenRouter는 연결 직후 `HTTP 200` 헤더와 `: OPENROUTER PROCESSING` 주석을 먼저 전송한 뒤 업스트림에서 `402`(잔액 고갈)·`429`(키 한도)·`502` 오류가 발생하면 스트림 본문에 `data: {"error":{"code":402,...}}` 프레임을 내려보낸다. 기존 `streamFromHandshake`는 `choices[0].delta.content`만 추출하고 `json.error`를 무시한 채 `statusCode = 200`으로 리스를 반납하여 **파산(`402`)·한도 초과(`429`) 키가 정상 `ACTIVE`로 유지**되는 결함이 있었다. 또한 헤더 수신 이후 `reader.read()`에 청크 유휴 타임아웃이 없어 반개방(Half-Open) 소켓 정체 시 `60s` 서버리스 강제 종료까지 대기할 위험이 있었다.
   - **패치**: `json?.error` 감지 시 `HealthAndCooldownEngine` 분류 규칙에 따라 `402`(계정 단위 `EXHAUSTED` 일괄 전파)·`401`/비모더레이션 `403`(단일 키 `EXHAUSTED`)·`429`(`RATE_LIMITED` 쿨다운)·프로바이더 장애/모더레이션(패널티 `0`)을 정확히 기록 후 예외를 전파하도록 패치했다. 아울러 청크당 유휴 워치독(`chunkTimeoutMs`, 기본 `25,000ms` < `45s` ZSET 리스 < `60s` 서버리스 한도, 매 `read` 종료 시 `clearTimeout` 보장 및 동기 `reader.cancel` 경합 방지 `timedOutError` 플래그 적용)과 `256KB` SSE 라인 버퍼 상한을 추가했다.
2. **백엔드 `/v2/ask` 비문자열 `message` 밀수·스키마 노출(`422`) 차단 및 `/v2/widget/view` 보조 필드 `413` 방어 + `chat_bubble_size` 서버 검증 동기화 (`my-server-test/src/endpoints/v2/widget-endpoints.ts`, `lib/url-guard.ts`)**
   - **원인**: `/v2/ask` 라우트 스키마가 `message: t.String()`을 강제하여 미등록 `widgetId`가 `message` 없이 호출하거나 `4,500자` 규모의 비문자열 중첩 객체(`{"message":{"bomb":"..."}}`)를 밀수할 경우 `403`/`413` 대신 TypeBox 내부 스키마 구조가 담긴 `422`를 노출했고, `/v2/widget/view` 역시 `threadId`가 `100자`를 넘으면 `422`로 실패하거나 `2,000자` 초과 토큰 폭탄에 `413`을 반환하지 않았다.
   - **패치**: `/v2/ask`에서 비문자열 `message` 직렬화 크기가 `4,000자`를 초과하면 즉시 `HTTP 413`으로 차단하고, 미등록 `widgetId` 요청은 `message` 누락 시에도 항상 `HTTP 403`으로 차단하도록 순서를 정렬했다. `/v2/widget/view`에는 `2,000자` 상한(`HTTP 413`)과 `101~2,000자` 손상 `threadId` 자동 폐기·신규 발급(`HTTP 200`)을 적용했으며, 백엔드 `isValidWidgetBubbleSize()` 및 `renderPersona()`에서도 `100vw`·`99999px` 등 클릭재킹 치수를 원천 거부하도록 동기화했다.
3. **프런트엔드 `localStorage` 오염·손상 JSON·사파리 프라이빗 모드 크래시 방어 및 초장문 `threadId` 영구 `413` Self-DoS 차단 (`tokki-widget/lib/state/chat.tsx`)**
   - **원인**: `_getStorageData`와 `_setStorageData`가 예외 처리 없이 `JSON.parse` 및 `localStorage.setItem`을 호출하여 손상된 JSON, 프라이빗 브라우징 `SecurityError`, 용량 초과(`QuotaExceededError`) 시 위젯이 크래시될 수 있었고, `localStorage` 내 `threadId`가 `100자` 초과 문자열이나 비문자열로 오염되면 매 질문마다 영구적으로 `HTTP 413`/`400`에 막히는 Self-DoS 및 `user` 개인정보(전화번호·이메일) 평문 저장 문제가 있었다.
   - **패치**: 전 구간 `try/catch` 자가 복구 래퍼를 적용하고, 복원·저장 시 `threadId`(`100자` 이하 제어문자 없는 문자열만 허용, 위반 시 `""` 초기화)와 최근 50개 메시지 배열 구조만 정화하여 저장(`waitingResponse: false` 고정, `user` PII 및 리스너 함수 저장 원천 배제)하도록 강화했다.
4. **임베드 `sanitizeBaseUrl()` 악성 스킴 차단, 만료 스레드 빈 이력(`messages: []`) 동기화 및 `ReactDOM.Root` 재사용 (`tokki-widget/lib/utils/sanitize-url.ts`, `lib/export.tsx`)**
   - **원인**: `data-base-url` 또는 `MountConfig.baseUrl`에 `javascript:`·자격증명 포함 URL·후행 슬래시(`///`)가 주입될 때 정화 로직이 없었고, 서버에서 만료된 스레드를 교체하며 빈 배열(`messages: []`)을 반환할 때 `length > 0` 조건 때문에 `hydrateFromServer`가 생략되어 구 `localStorage` 메시지가 다시 덮어써졌으며, 반복 `mount()` 호출 시 동일 컨테이너에 `ReactDOM.createRoot`가 중복 생성되었다.
   - **패치**: `http:`/`https:` 무자격증명 오리진만 허용하고 후행 슬래시를 제거하는 `sanitizeBaseUrl()`과 `sanitizeImageUrl()`을 `export.tsx` 전반에 적용하고, `Array.isArray(payload.messages)`(빈 배열 포함) 전체에 대해 서버 정본 동기화를 수행하며, `WeakMap<HTMLElement, ReactDOM.Root>`로 루트 인스턴스를 재사용하여 메모리·파이버 누수를 원천 차단했다.

### 3.2 실시간 `/usr/bin/curl` 적대적 보안 경계 검증 로그 (22개 공격·경계 벡터 전량 통과)

| 벡터 ID | 실측 공격·경계 시나리오 (`/usr/bin/curl`) | 기대 상태 | 실측 상태 | 응답 본문 요약 | 소요 시간 | 판정 |
| :---: | :--- | :---: | :---: | :--- | :---: | :---: |
| `V01` | `POST /v2/ask` — `widgetId` 필드 누락 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `12.34 ms` | **PASS** |
| `V02` | `POST /v2/ask` — 미등록 `widgetId` 변조 (`"evil-spoof-widget-999"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `8.54 ms` | **PASS** |
| `V03` | `POST /v2/ask` — SQL 인젝션 `widgetId` (`"' OR '1'='1"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `7.15 ms` | **PASS** |
| `V04` | `POST /v2/ask` — 초장문 `widgetId` (500자, DB 무조회 즉시 차단) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `7.16 ms` | **PASS** |
| `V05` | `POST /v2/ask` — 미등록 `widgetId` + `message` 누락 (`422` 스키마 노출 없이 `403`, 신규 패치) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.64 ms` | **PASS** |
| `V06` | `POST /v2/widget/create-thread` — 미등록 `widgetId` 스레드 발급 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id"}` | `6.98 ms` | **PASS** |
| `V07` | `POST /v2/ask` — 정상 최대 경계값 `message` 정확히 `4,000자` | `200` | **`200`** | `data: 토키%20 ... data: [DONE]` (정상 SSE 스트리밍) | `61.48 ms` | **PASS** |
| `V08` | `POST /v2/ask` — 경계 초과 `message` `4,001자` | `413` | **`413`** | `{"success":false,"error":"message too long (4001 > 4000 chars)"}` | `8.07 ms` | **PASS** |
| `V09` | `POST /v2/ask` — `50,000자` 한글 토큰 폭탄 (Token Bomb) | `413` | **`413`** | `{"success":false,"error":"message too long (50000 > 4000 chars)"}` | `6.90 ms` | **PASS** |
| `V10` | `POST /v2/ask` — 비문자열 `message` 중첩 객체 밀수 (`4,500자` → `413`, 신규 패치) | `413` | **`413`** | `{"success":false,"error":"message too long (4511 > 4000 chars)"}` | `5.96 ms` | **PASS** |
| `V11` | `POST /v2/ask` — `browserInfo` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"browserInfo too large (2508 > 2000 chars)"}` | `5.76 ms` | **PASS** |
| `V12` | `POST /v2/ask` — `threadId` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2500 > 2000 chars)"}` | `5.57 ms` | **PASS** |
| `V13` | `POST /v2/ask` — `search` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"search options too large (2500 > 2000 chars)"}` | `5.89 ms` | **PASS** |
| `V14` | `POST /v2/widget/view` — `threadId` 보조 필드 밀수 (`2,500자` → `413`, 신규 패치) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2500 > 2000 chars)"}` | `6.30 ms` | **PASS** |
| `V15` | `POST /v2/ask` — `Content-Length > 1MB` (`1.15MB` 바디 선차단) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.31 ms` | **PASS** |
| `V16` | `POST /v2/ask` — Chunked + `APPLICATION/JSON ; charset=utf-8` `1.15MB` 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `6.32 ms` | **PASS** |
| `V17` | `POST /v2/ask` — 상충 복수 `Content-Length: 10, 2097152` 스머글링 차단 (RFC 9112) | `400` / `413` | **`400`** | 소켓 HTTP 파서 계층 `400` 즉시 차단 + 프록시 정규화 시 `onRequest` `413` 이중 방어 | `4.81 ms` | **PASS** |
| `V18` | `POST /v2/admin/widgets/upload-icon` — Chunked `2.35MB` 멀티파트 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 2MB limit"}` | `7.34 ms` | **PASS** |
| `V19` | `POST /v2/admin/widgets/upsert` — 전체화면 클릭재킹 `chat_bubble_size` (`"100vw"`) 차단 (신규 패치) | `400` | **`400`** | `{"success":false,"error":"invalid chat_bubble_size (must be a safe CSS size like '48px' or '3.5rem')"}` | `6.46 ms` | **PASS** |
| `V20` | `POST /v2/admin/widgets/upsert` — 프로토콜 상대·백슬래시 `icon_url` (`"/\\evil.attacker.com/p.svg"`) 차단 | `400` | **`400`** | `{"success":false,"error":"invalid icon_url (must be http(s):// or relative / path)"}` | `4.73 ms` | **PASS** |
| `V21` | `POST /v2/widget/view` — `widgetId: null, threadId: null` 고아 스레드 무생성 검증 | `200` | **`200`** | `{"success":true,"thread_id":"",...}` (DB 고아 스레드 생성 `0건`) | `4.56 ms` | **PASS** |
| `V22` | `POST /v2/ask` — 동일 IP 분당 10회 초과 폭주 방어 (11번째 요청) | `429` | **`429`** | `{"success":false,"error":"Too Many Requests",...,"retryAfter":60}` | `4.53 ms` | **PASS** |

---

## 4. R3: 자동화 무결성 검증 및 프리플라이트 빌드 결과

### 4.1 테스트 스위트 실행 결과 (`bun test`)

| 저장소 | 테스트 파일 수 | 통과 / 실패 | `expect()` 단언문 수 | 실행 시간 | 종료 코드 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`my-server-test` (백엔드)** | 13개 파일 | **`318 PASS / 0 FAIL`** | `2,026`개 | `6.06s` | `0` |
| **`tokki-widget` (프런트엔드)** | 2개 파일 | **`40 PASS / 0 FAIL`** | `205`개 | `0.22s` | `0` |
| **합계** | **15개 파일** | **`358 PASS / 0 FAIL` (100%)** | **`2,231`개** | **`6.28s`** | **`0`** |

### 4.2 로컬 프리플라이트 빌드 검증

- **백엔드 번들 동기화 (`my-server-test`)**:
  - `npm run bundle:api` → 7개 SQL 마이그레이션 인라인(`src/generated-migrations.ts`) 및 단일 서버리스 번들 `api/index.js` (`27.0MB`, Node 24 CJS) 빌드 성공 (`103ms`).
  - Node.js CJS 핸들러 스모크 검증 (`require("./api/index.js").default` → `GET /v1/healthz`) → `HTTP 200 OK` 정상 반환 확인.
- **프런트엔드 타입체크 및 프로덕션 번들 빌드 (`tokki-widget`)**:
  - `npm run type-check` (`tsc`) → 타입 오류 `0건`.
  - `npm run build` (라이브러리 빌드 + `.d.ts` 생성) → `dist/` 정상 생성 (`2.74s`).
  - `npm run build:embed` (임베드 단일 스크립트 빌드) → `dist-embed/tokki.js` 및 `public/embed/tokki.js` (`2,137.73 kB` / gzip `625.86 kB`) 동기화 완료 (`2.06s`).
  - `npm run export-playground` (플레이그라운드 번들 빌드) → `export-playground/main.js` 정상 생성 (`2.40s`).

---

## 5. 수락 기준(Acceptance Criteria) 최종 점검표

- [x] **[성능 및 방어 무결성]** 제어된 동시 요청(18건 + 12건) 및 HTTP 429/402/401/403 + 인밴드 스트림 오류 주입 환경에서 교착 상태나 메모리·세마포어 누수(`ZCARD = 0`) 없이 **100% 페일오버**를 달성했는가? → **달성 완료 (`83.06 ms` / `71.46 ms`, 완주율 100%, 파산 형제 키 호출 `0건`, 인밴드 `402` 계정 격리 및 스톨 워치독 검증 완료, `ZCARD = 0`)**
- [x] **[보안 경계 입증]** 악의적 `widgetId` 변조(`HTTP 403`) 및 초대형 페이로드·토큰 폭탄 공격(`HTTP 413`) 차단이 실측 로그로 입증되었는가? → **22개 실전 `curl` 벡터 전량 통과(`22/22 PASS`) 및 4건의 신규 스트리밍·페이로드·스토리지·임베드 보안 취약점 즉시 패치 완료**
- [x] **[최종 산출물]** 한국어 감사 보고서(`stress_test_audit.md`)가 생성되었는가? → **양쪽 워크스페이스(`my-server-test`, `tokki-widget`)에 한국어로 생성 완료**
- [x] **[테스트 무결성]** 모든 방어 테스트(`bun test`)가 종료 코드 `0`으로 100% 통과했는가? → **`358 / 358 PASS` (`2,231` assertions, `Exit Code 0`)**
- [x] **[쿼터 보호]** 커밋 메시지에 `[skip ci]`가 포함되어 Vercel 및 GitHub Actions 무료 쿼터를 보호했는가? → **`fix(tokki): automated defense and load test patch [skip ci]` 로컬 커밋 적용 완료 (무료 배포 쿼터 보호를 위해 불필요한 원격 푸시 생략)**
