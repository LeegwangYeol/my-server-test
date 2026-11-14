# 토키 위젯(Tokki Widget) 및 백엔드 서버 일일 부하 테스트 · 적대적 보안 점검 보고서

- **감사 문서 ID**: `AUDIT-TOKKI-DAILY-20261115`
- **세션명**: `[세션명: 토키 위젯 일일 부하 테스트]`
- **문서 버전**: `v6.3.0-DAILY-KO`
- **점검 일시**: 2026년 11월 15일 03:21 KST (`2026-11-15T03:21:05+09:00`)
- **점검 대상**:
  - 백엔드 (`my-server-test`): `/Users/user/src/my-server-test` (`https://my-server-mocha.vercel.app`, Node `v24.22.2` / `iad1` 활성 확인)
  - 프런트엔드 (`tokki-widget`): `/Users/user/src/tokki-widget`
- **실행 모드**: 단일 에이전트 집중 점검 (`development` 무결성 모드 — 대규모 스웜 배제, 외부 클라우드 무료 쿼터 소모 `0`)
- **최종 판정**: **전 항목 통과 (100% PASS — 발견된 경계 취약점 7건 즉시 패치 및 영구 회귀 테스트 반영 완료)**

---

## 1. 핵심 요약 (Executive Summary)

본 일일 정기 점검은 외부 유료/무료 클라우드 쿼터(Vercel Serverless CPU/빌드 한도, Supabase DB, OpenRouter 크레딧)를 일절 소모하지 않는 로컬 허메틱(Hermetic) 실전 HTTP 서버(`Bun.serve` + `createApp(true)`)와 실제 `/usr/bin/curl` 프로세스를 결합하여 수행되었다.

1. **[R1] 경량 동시성 제어 및 HTTP 429/402 페일오버 방어 검증 (`api_key_rotation_plan.md` 준수)**:
   - 5개 API 키·4개 계정 풀(`acc-bankrupt` 파산 계정 2키 [Mock `402`], `acc-ratelim-1` 속도 제한 [Mock `429 Retry-After: 12`], `acc-ratelim-2` 속도 제한 [Mock `429 X-RateLimit-Reset`], `acc-healthy` 정상 계정 [Mock `200` SSE]) 환경에서 **1차 동시 부하 18건(정상 SSE 완주 16건 + 스트리밍 중 강제 연결 종료 2건)** 및 **2차 후속 동시 부하 12건**을 실행했다.
   - **1차 콜드 동시 버스트(18건)** 전체 완료 시간 **`69.62ms`**(`p50: 59.50ms`, `p95/Max: 69.45ms`), **2차 웜 스테디스테이트(12건)** 전체 완료 시간 **`38.76ms`**(`p50: 38.41ms`, `p95/Max: 38.56ms`)로 서버리스 타임아웃(`60,000ms`) 대비 **0.12% 이내**에 교착 상태(Deadlock) 없이 **100% 페일오버 완주**를 달성했다.
   - 1차 버스트에서 파산(`EXHAUSTED`) 및 속도 제한(`RATE_LIMITED`) 상태가 기록된 직후, 2차 웨이브 12건에서는 불량 키(1~4번 키) 업스트림 호출이 정확히 **`0건`**으로 차단되었으며, 스트림 종료 및 강제 중단(`499`) 이후 전 키의 ZSET 세마포어 리스 잔량(`inFlightRequests`)은 **`ZCARD = 0`**, GC 이후 힙 메모리 변화량은 **`-13,818.90 KB`**로 메모리·세마포어 누수가 전무함을 입증했다.
2. **[R2] 프런트엔드-백엔드 적대적 보안 감사 및 즉시 패치 (7건 보강)**:
   - 미등록/누락/SQLi/초장문 `widgetId` 변조 요청이 `/v2/ask` 및 `/v2/widget/create-thread`에서 **100% `HTTP 403 Forbidden`**으로 차단됨을 실측 확인했다.
   - 코드 정밀 감사 중 적발된 **7건의 우회 가능 경계 결함**(대문자·공백 포함 `Content-Type` >1MB 스트리밍 시 413 우회, `/v2/ask` `multipart/form-data` 서브스트링 스푸핑을 통한 2MB 한도 우회, `/v2/widget/view` 미등록 `widgetId` 고아 스레드 DB 스팸, `/v2/ask` 비문자열 `threadId` 객체 스머글링/null 처리, 4~5키 풀 `RotatingLLMProvider` 기본 `maxAttempts=3` 고정 및 `perAttemptTimeoutMs` 미전달, 프런트엔드 `<style>` 태그 DOM XSS 브레이크아웃, 직접 `startQuestion` 호출 시 4,000자 우회 및 `%25` SSE 디코딩 손실)을 **즉시 전량 패치**했다.
3. **[R3] 자동화 무결성 검증 및 빌드/쿼터 보호**:
   - 백엔드 `bun test` **286 / 286 PASS** (`1,790` assertions) + 프런트엔드 `bun test` **31 / 31 PASS** (`111` assertions) = **총 317 / 317 테스트 100% 통과 (`1,901` expect 단언문, Exit Code `0`)**.
   - 사전 빌드(`npm run bundle:api` → `api/index.js` `26.9MB`, `npm run type-check`, `npm run build`, `npm run build:embed`, `npm run export-playground`) 전량 무오류 통과 및 `[skip ci]` 커밋 규칙을 준수했다.

---

## 2. R1: 경량 동시성 제어 및 429/402 페일오버 방어 실측 결과

### 2.1 테스트 토폴로지 (5-Key ZSET 세마포어 풀)

| 키 ID | 소속 계정 (`accountId`) | 티어 / 가중치 | 주입 시나리오 | 웨이브 종료 후 상태 | 최종 `inFlightRequests` (`ZCARD`) |
| :--- | :--- | :---: | :--- | :---: | :---: |
| `key-1-bankrupt-a` | `acc-bankrupt` | Tier 0 / `100` | Mock `HTTP 402` (잔액 고갈) | `EXHAUSTED` | **`0`** |
| `key-2-bankrupt-b` | `acc-bankrupt` (형제 키) | Tier 0 / `90` | 동일 계정 파산 전파 대상 | `EXHAUSTED` | **`0`** |
| `key-3-ratelim-delta` | `acc-ratelim-1` | Tier 1 / `80` | Mock `HTTP 429` (`Retry-After: 12`) | `RATE_LIMITED` (~13.2s 쿨다운) | **`0`** |
| `key-4-ratelim-iso` | `acc-ratelim-2` | Tier 1 / `70` | Mock `HTTP 429` (`X-RateLimit-Reset` +15s) | `RATE_LIMITED` (~15.4s 쿨다운) | **`0`** |
| `key-5-healthy` | `acc-healthy` | Tier 2 / `60` | 정상 `HTTP 200` 멀티청크 SSE 스트리밍 | `ACTIVE` | **`0`** |

### 2.2 동시 요청 지연시간(Latency) · 페일오버 · 메모리 무결성 지표

| 측정 항목 | 1차 콜드 버스트 (동시 18건: 완주 16 + 중단 2) | 2차 웜 스테디스테이트 (동시 12건) | 허용 기준 (SLA) | 판정 |
| :--- | :---: | :---: | :---: | :---: |
| **총 동시 실행 Wall-Clock 시간** | **`69.62 ms`** | **`38.76 ms`** | `< 60,000 ms` (Vercel 한도) | **PASS** |
| **정상 SSE 완주 성공률** | **`16 / 16 (100%)`** | **`12 / 12 (100%)`** | `100%` (`data: [DONE]` 수신) | **PASS** |
| **지연시간 분포 (`Min / p50 / p95 / Max`)** | `59.46 / 59.50 / 69.45 / 69.45 ms` | `38.36 / 38.41 / 38.56 / 38.56 ms` | 무교착 · 타임아웃 내 완료 | **PASS** |
| **스트리밍 중 클라이언트 강제 중단 (`HTTP 499`)** | `2 / 2` 즉시 회수 (`42.21 ~ 42.25 ms`) | — | 좀비 리스 0건 유지 | **PASS** |
| **불량 키(1~4번) 업스트림 호출 건수** | 초기 경합 탐색 후 상태 전이 완료 | **`0 건`** (4개 불량 키 전원 즉시 우회) | 파산·쿨다운 키 재호출 `0` | **PASS** |
| **종료 후 ZSET 활성 리스 합계 (`ZCARD`)** | **`0`** | **`0`** | 정확히 `0` (Zero Leak) | **PASS** |
| **GC 후 스테디스테이트 힙 메모리 증감** | `44,509.56 KB` (1차 직후 기준점) | `30,690.66 KB` (**`-13,818.90 KB`**) | 메모리 누수 없음 | **PASS** |

> **프로덕션 헬스체크(무부하 단일 GET 확인)**: `https://my-server-mocha.vercel.app/v1/healthz` → `OK [HTTP 200]`, `/v1/heartbeat` → `{"status":"alive","node":"v24.22.2","region":"iad1"}` `[HTTP 200]` 정상 응답 확인 완료.

---

## 3. R2: 적대적 보안 감사 결과 및 즉시 패치 내역

### 3.1 발견 즉시 패치 완료한 방어선 취약점 (7건)

1. **`Content-Type` 대소문자·공백(RFC 9110 OWS) 및 스트리밍 바이트 상한 우회 차단 (`my-server-test/src/app.ts`)**
   - **원인**: Elysia 기본 파서 훅이 소문자 정확 일치 `"application/json"` 위주로 동작하여 `Content-Type: APPLICATION/JSON` 또는 `application/json ; charset=utf-8`(세미콜론 앞 공백) + `Transfer-Encoding: chunked`(Content-Length 생략)로 1.2MB 본문을 전송할 경우 `HTTP 413` 대신 `422`까지 파싱이 진행되었으며, `request.text()` 전체 버퍼링 후 길이를 검사해 대용량 스트림 시 힙 압박 위험이 있었다.
   - **패치**: `extractMediaType()` 정규화 및 `ReadableStreamDefaultReader` 기반 증분 바이트 계측 함수 `readBoundedBodyText(request, 1MB)`를 도입하여 `1,048,576 bytes` 초과 즉시 스트림을 `cancel()`하고 `HTTP 413` + CORS 헤더를 반환하도록 강화했다.
2. **`multipart/form-data` 파라미터 스푸핑을 통한 2MB 한도 우회 차단 (`my-server-test/src/app.ts`)**
   - **원인**: `contentType.includes("multipart/form-data")` 서브스트링 검사로 인해 `/v2/ask`에 `Content-Type: application/json; x=multipart/form-data` 헤더를 붙여 보내면 본문 허용치가 1MB에서 2MB로 상승했다.
   - **패치**: 2MB 예외 한도는 오직 `mediaType === "multipart/form-data"` 이면서 정규화 경로가 정확히 `"/v2/admin/widgets/upload-icon"`일 때만 허용하도록 격리했다.
3. **`/v2/widget/view` 미등록 `widgetId` 고아 스레드(Orphan Thread) DB 오염 차단 (`my-server-test/src/endpoints/v2/widget-endpoints.ts`)**
   - **원인**: `/v2/widget/view`가 `getWidget(widgetId)` 등록 여부를 확인하기 전에 `createThread(widgetId)`를 먼저 호출하여, 미등록/빈 `widgetId` 요청마다 `chat_thread` 테이블에 고아 행이 생성될 수 있었다.
   - **패치**: `getWidget(widgetId)`(`<= 100자`) 검증을 최우선 실행하여 등록된 위젯(`master !== null`)일 때만 스레드 조회·생성을 수행하고, 미등록 위젯은 DB 쓰기 없이 기본 페르소나와 `thread_id: ""`만 반환하도록 수정했다. 또한 `/v2/widget/create-thread` 및 `/v2/ask`에서도 100자 초과 `widgetId`는 DB 조회 없이 즉시 `HTTP 403`을 반환하도록 차단했다.
4. **`/v2/ask` 비문자열 `threadId` 객체 스머글링(413) 및 `null` 호환성 보강 (`my-server-test/src/endpoints/v2/widget-endpoints.ts`)**
   - **원인**: 스키마 `threadId: t.Optional(t.String())`로 인해 클라이언트가 `threadId: null` 전송 시 화이트리스트 `403` 대신 `422`가 발생하거나, 비문자열 대용량 객체 주입 시 `413` 대신 `422`가 반환되었다.
   - **패치**: `threadId`를 Guard 1b에서 정밀 검사하여 `null`/`undefined`는 빈 문자열로 안전 정규화하고, 직렬화 길이 `> 2,000자` 객체/배열 스머글링은 `HTTP 413`, 그 외 비문자열 타입 혼동은 `HTTP 400`으로 정확히 차단했다.
5. **다중 키 풀(4~5키) `RotatingLLMProvider` 재시도 횟수 자동 확장 및 타임아웃 전달 (`my-server-test/lib/llm/rotating-provider.ts`, `lib/llm/key-manager/executor.ts`)**
   - **원인**: `maxAttempts` 기본값이 `3`으로 고정되어 5개 키 풀에서 앞선 3개 키가 `402`/`429` 실패 시 4~5번째 정상 키에 도달하기 전에 종료될 수 있었고, `this.perAttemptTimeoutMs`가 `executeWithResilientFailover`에 전달되지 않고 `6000ms`로 하드코딩되어 있었다.
   - **패치**: 기본 `maxAttempts`를 키 풀 크기(`Math.max(3, Math.min(keyConfigMap.size, 5))`)에 맞춰 자동 산정하고 `perAttemptTimeoutMs`를 `createAttemptSignal`까지 정확히 전달했다.
6. **프런트엔드 `<style>` 인젝션(DOM XSS) 원천 차단 및 기본 백엔드 도메인 정상화 (`tokki-widget/lib/utils/sanitize-css.ts`, `lib/export.tsx`, `lib/components/ChatWindow.tsx`, `src/App.tsx`)**
   - **원인**: `injectFontStyle`(`externalFont`, `fontFamily`)과 `ChatWindow.tsx` 인라인 `<style>`(`chatInputPlaceholderColor`, `chatLinkMessageTextColor`)이 값을 검증 없이 삽입하여 `</style><script>...` 형태의 DOM XSS 브레이크아웃 가능성이 있었고, `src/App.tsx`의 `DEFAULT_BASE_URL`이 비활성화된 구 도메인을 가리키고 있었다.
   - **패치**: `sanitizeCssFontName` 및 `sanitizeCssColorValue` 화이트리스트 새니타이저를 적용하고, `src/App.tsx` 기본 URL을 활성 도메인(`https://my-server-mocha.vercel.app`)으로 동기화했다.
7. **프런트엔드 직접 `startQuestion` 4,000자 차단 · 동시 전송 재진입 잠금 · 무손실 SSE 디코딩 (`tokki-widget/lib/state/chat.tsx`, `lib/components/ChatWindow.tsx`)**
   - **원인**: `submitMessage`와 달리 `chatOps.startQuestion` 직접 호출에는 4,000자 상한 검사가 없었고, `waitingResponse` 중 중복 제출 차단과 백엔드가 인코딩한 `%25`(`%`), `%0d`(`\r`) 복원이 누락되어 있었다.
   - **패치**: `startQuestion` 최상단 4,000자 차단 가드, `submitMessage` 및 추천 질문 버튼의 `waitingResponse` 재진입 잠금, `getAbortSignal()` 중단 시그널 자동 재생성, `decodeSseChunk` 무손실 복원(`%0d` → `\r`, `%0a` → `\n`, `%20` → 공백, `%25` → `%`)을 적용했다.

### 3.2 실시간 `curl` 적대적 보안 경계 검증 로그 (12개 공격 벡터)

| # | 공격 벡터 (`curl` 실측 요청) | 기대 코드 | 실측 코드 | 응답 본문 요약 | 소요 시간 | 판정 |
| :-: | :--- | :---: | :---: | :--- | :---: | :---: |
| 1 | `POST /v2/ask` — `widgetId` 필드 누락 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `8.85 ms` | **PASS** |
| 2 | `POST /v2/ask` — 미등록 `widgetId: "evil-tampered-widget-999"` | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `7.02 ms` | **PASS** |
| 3 | `POST /v2/ask` — SQLi `widgetId: "' OR '1'='1"` + `threadId: null` | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.26 ms` | **PASS** |
| 4 | `POST /v2/widget/create-thread` — 미등록 `widgetId` | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id"}` | `7.00 ms` | **PASS** |
| 5 | `POST /v2/ask` — 1,000자 초장문 `widgetId` (DB 조회 무실행 즉시 거부) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.70 ms` | **PASS** |
| 6 | `POST /v2/widget/view` — 미등록 `widgetId` 고아 스레드 생성 차단 확인 | `200` (`thread_id:""`) | **`200`** | `{"success":true,"thread_id":"","messages":[]...}` (`createThread` 호출 `0회`) | `6.34 ms` | **PASS** |
| 7 | `POST /v2/ask` — `message` 4,001자 경계 초과 | `413` | **`413`** | `{"success":false,"error":"message too long (4001 > 4000 chars)"}` | `5.39 ms` | **PASS** |
| 8 | `POST /v2/ask` — `message` 50,000자 한글 토큰 폭탄 (Token Bomb) | `413` | **`413`** | `{"success":false,"error":"message too long (50000 > 4000 chars)"}` | `5.22 ms` | **PASS** |
| 9 | `POST /v2/ask` — `threadId` 비문자열 객체 스머글링 (`2,515 chars`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2515 > 2000 chars)"}` | `4.81 ms` | **PASS** |
| 10 | `POST /v2/ask` — 대문자 `APPLICATION/JSON` + Chunked 1.2MB 본문 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.68 ms` | **PASS** |
| 11 | `POST /v2/ask` — RFC 9110 OWS `application/json ; charset=utf-8` 1.2MB 본문 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.67 ms` | **PASS** |
| 12 | `POST /v2/ask` — `application/json; x=multipart/form-data` 스푸핑 1.6MB 본문 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.17 ms` | **PASS** |

---

## 4. R3: 자동화 테스트 스위트 및 사전 빌드 검증 결과

### 4.1 테스트 스위트 실행 요약 (`bun test`)

| 저장소 | 테스트 파일 수 | 통과 / 실패 | `expect()` 단언문 수 | 소요 시간 | 종료 코드 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`my-server-test` (백엔드)** | 13개 파일 | **`286 PASS / 0 FAIL`** | `1,790`개 | `4.65s` | `0` |
| **`tokki-widget` (프런트엔드)** | 2개 파일 | **`31 PASS / 0 FAIL`** | `111`개 | `0.04s` | `0` |
| **합계** | **15개 파일** | **`317 PASS / 0 FAIL` (100%)** | **`1,901`개** | **`4.69s`** | **`0`** |

### 4.2 로컬 프리플라이트 빌드 검증

- **백엔드 번들 동기화 (`my-server-test`)**:
  - `npm run bundle:api` → 7개 SQL 마이그레이션 인라인 생성 및 `api/index.js` (`26.9MB`, Node 24 CJS) 빌드 성공 (`114ms`).
  - Node.js 런타임 직접 로드 스모크 체크(`require('./api/index.js').default` → `/v1/healthz`) → `HTTP 200 OK` 확인 완료.
- **프런트엔드 타입체크 및 번들 빌드 (`tokki-widget`)**:
  - `npm run type-check` (`tsc`) → 오류 `0건`.
  - `npm run build` (라이브러리 빌드) → `dist/` 정상 생성 (`2.77s`).
  - `npm run build:embed` (임베드 번들) → `dist-embed/tokki.js` 및 `public/embed/tokki.js` 동기화 완료 (`2.02s`).
  - `npm run export-playground` (플레이그라운드 앱 빌드) → `export-playground/main.js` 정상 생성 (`2.40s`).

---

## 5. 수락 기준(Acceptance Criteria) 최종 점검표

- [x] **[성능 및 방어 무결성]** 제어된 동시 요청(18건+12건) 및 HTTP 429/402 오류 주입 환경에서 교착 상태나 세마포어/메모리 누수(`ZCARD = 0`) 없이 **100% 페일오버**를 달성했는가? → **달성 완료 (`69.62ms` / `38.76ms`, 100% 성공)**
- [x] **[보안 경계 입증]** 악의적 `widgetId` 변조(`HTTP 403`) 및 초대형/우회 페이로드·토큰 폭탄 공격(`HTTP 413`) 차단 여부가 실측 로그로 입증되었는가? → **12종 `curl` 실측 로그 및 회귀 테스트로 입증 완료**
- [x] **[최종 산출물]** 한국어 감사 보고서(`stress_test_audit.md`)가 생성되었는가? → **양쪽 워크스페이스에 생성 완료**
- [x] **[테스트 무결성]** 모든 방어 테스트(`bun test`)가 종료 코드 `0`으로 100% 통과했는가? → **`317 / 317 PASS` (`Exit Code 0`)**
- [x] **[쿼터 보호]** 코드 수정 커밋 시 Vercel/GitHub Actions 빌드 쿼터 보호를 위해 `[skip ci]`가 포함되었는가? → **`fix(tokki): automated defense and load test patch [skip ci]` 적용 완료**
