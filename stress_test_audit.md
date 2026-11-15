# 토키 위젯(Tokki Widget) 및 백엔드 서버 일일 부하 테스트 · 적대적 보안 점검 보고서

- **감사 문서 ID**: `AUDIT-TOKKI-DAILY-20261116`
- **세션명**: `[세션명: 토키 위젯 일일 부하 테스트]`
- **문서 버전**: `v6.4.0-DAILY-KO`
- **점검 일시**: 2026년 11월 16일 03:20 KST (`2026-11-16T03:20:00+09:00`)
- **점검 대상**:
  - 백엔드 (`my-server-test`): `/Users/user/src/my-server-test` (`https://my-server-mocha.vercel.app`, Node `v24.22.2` / `iad1` / `commitSha: cb5f128` 활성 확인)
  - 프런트엔드 (`tokki-widget`): `/Users/user/src/tokki-widget`
- **실행 모드**: 단일 에이전트 집중 점검 (`development` 무결성 모드 — 멀티 에이전트 스웜 미사용, 외부 클라우드 유·무료 쿼터 부하 `0`)
- **최종 판정**: **전 항목 통과 (100% PASS — 신규 적발된 방어선 취약점 5건 즉시 패치 및 영구 회귀 테스트 반영 완료)**

---

## 1. 핵심 요약 (Executive Summary)

본 일일 정기 점검은 외부 제3자 클라우드 무료 플랜 한도(Vercel Serverless Active CPU·일일 배포 횟수, Supabase DB, OpenRouter 크레딧)를 보호하기 위해 로컬 허메틱(Hermetic) 실전 HTTP 서버(`Bun.serve` + `createApp(true)`)와 실제 `/usr/bin/curl` 프로세스 위에서 수행되었다(라이브 프로덕션 `my-server-mocha.vercel.app`에는 무부하 단일 헬스체크 GET 2회만 수행).

1. **[R1] 제어된 경량 동시성 제어 및 HTTP 429/402 페일오버 방어 검증 (`api_key_rotation_plan.md` 준수)**:
   - 5개 API 키·4개 계정 풀(`acc-bankrupt` 파산 계정 2개 형제 키 [Mock `402`], `acc-ratelim-1` 속도 제한 [Mock `429 Retry-After: 12`], `acc-ratelim-2` 속도 제한 [Mock `429 Retry-After: HTTP-date +15s`], `acc-healthy` 정상 계정 [Mock `200` 멀티청크 SSE])을 대상으로 **1차 동시 부하 18건(정상 SSE 완주 16건 + 스트리밍 도중 클라이언트 강제 연결 종료 2건)** 및 **2차 웜 스테디스테이트 동시 부하 12건**을 실행했다.
   - **1차 콜드 페일오버 버스트(18건)** 총 소요 시간 **`90.10 ms`**(`Min: 84.04 ms`, `p50: 86.26 ms`, `p95/Max: 89.45 ms`), **2차 웜 스테디스테이트(12건)** 총 소요 시간 **`85.93 ms`**(`Min: 83.06 ms`, `p50: 84.40 ms`, `p95/Max: 85.33 ms`)로 서버리스 타임아웃(`60,000 ms`)의 **0.15% 이내**에 교착 상태(Deadlock) 없이 **100% 페일오버 완주**를 달성했다.
   - `k1-dead-a`에서 최초 `HTTP 402`가 감지된 즉시 동일 계정(`acc-bankrupt`) 소속 형제 키 `k2-dead-b`는 **업스트림 호출 `0건`**으로 즉시 파산(`EXHAUSTED`) 격리되었으며, 2차 웨이브 12건에서는 파산·쿨다운 상태의 불량 키(1~4번 키) 호출이 **`0건`**으로 완벽히 차단되었다. 모든 스트림 완주 및 강제 중단(`499`) 직후 전 키의 ZSET 활성 리스 수(`inFlightRequests`)는 **`ZCARD = 0`**으로 회수되어 세마포어·메모리 누수가 없음을 확인했다.
2. **[R2] 프런트엔드-백엔드 적대적 보안 감사 및 즉시 패치 (5건 신규 보강)**:
   - 미등록/누락/SQLi/초장문 `widgetId` 변조 요청이 `/v2/ask` 및 `/v2/widget/create-thread`에서 **100% `HTTP 403 Forbidden`**으로 차단되고, `4,000자` 초과 메시지·`2,000자` 초과 보조 필드·`1MB`(업로드 `2MB`) 초과 스트리밍 본문이 **100% `HTTP 413 Payload Too Large`**로 차단됨을 16개 실전 `curl` 벡터로 입증했다.
   - 정밀 코드 감사 과정에서 발견된 **5건의 우회 가능 취약점**(① `@uiw/react-markdown-preview`의 `rehype-raw` + 무필터 `urlTransform`으로 인한 호스트 페이지 DOM XSS, ② `FunctionCall.tsx`의 `javascript:`/`data:` URI 스킴 허용 XSS, ③ `Content-Length: 10, 2097152` 콤마 스머글링 및 `/v2/admin/widgets/upload-icon` Chunked `>2MB` 무제한 스트림 버퍼링 우회, ④ 업스트림 비재시도 4xx 응답 시 빈 `200 text/event-stream` 오반환 및 `/v2/widget/view` `null` 스키마 처리, ⑤ `402` 파산 계정 충전 후 `resetKeyToActive()` 호출 시 `brokenAccounts` 24시간 잔류 교착 버그)을 **즉시 전량 패치**했다.
3. **[R3] 자동화 무결성 검증 및 프리플라이트 빌드·쿼터 보호**:
   - 백엔드 `bun test` **295 / 295 PASS** (`1,833` assertions) + 프런트엔드 `bun test` **33 / 33 PASS** (`136` assertions) = **총 328 / 328 테스트 100% 통과 (`1,969` expect 단언문, 종료 코드 `0`)**.
   - 사전 빌드(`npm run bundle:api` → `api/index.js` `26.9MB`, `npm run type-check`, `npm run build`, `npm run build:embed`, `npm run export-playground`) 전량 무오류 통과 및 `[skip ci]` 로컬 커밋 규칙을 준수했다.

---

## 2. R1: 경량 동시성 제어 및 429/402 페일오버 방어 실측 결과

### 2.1 테스트 토폴로지 (5-Key / 4-Account ZSET 세마포어 풀)

| 키 ID | 소속 계정 (`accountId`) | 티어 / 가중치 | 오류 주입 시나리오 | 1차 웨이브 호출 수 | 2차 웨이브 호출 수 | 종료 후 상태 / 서킷 | 최종 `ZCARD` (`inFlightRequests`) |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: | :---: |
| `k1-dead-a` | `acc-bankrupt` | Tier 0 / `100` | Mock `HTTP 402` (크레딧 고갈) | `1회` | **`0회`** | `EXHAUSTED` / `OPEN` | **`0`** |
| `k2-dead-b` | `acc-bankrupt` (형제 키) | Tier 0 / `95` | 동일 계정 파산 즉시 전파 대상 | **`0회`** (Fast-Break) | **`0회`** | `EXHAUSTED` / `OPEN` | **`0`** |
| `k3-rl-delta` | `acc-ratelim-1` | Tier 0 / `85` | Mock `HTTP 429` (`Retry-After: 12`) | `1회` | **`0회`** | `RATE_LIMITED` / `OPEN` | **`0`** |
| `k4-rl-date` | `acc-ratelim-2` | Tier 0 / `75` | Mock `HTTP 429` (`Retry-After: HTTP-date`) | `1회` | **`0회`** | `RATE_LIMITED` / `OPEN` | **`0`** |
| `k5-healthy` | `acc-healthy` | Tier 1 / `60` | 정상 `HTTP 200` 4청크 SSE 스트리밍 | `18회` (완주 16 + 중단 2) | **`12회`** | `ACTIVE` / `CLOSED` | **`0`** |

### 2.2 동시 요청 지연시간(Latency) · 페일오버 · 리소스 회수 지표

| 측정 항목 | 1차 콜드 페일오버 버스트 (동시 18건: 완주 16 + 중단 2) | 2차 웜 스테디스테이트 (동시 12건) | 허용 기준 (SLA) | 판정 |
| :--- | :---: | :---: | :---: | :---: |
| **총 동시 실행 Wall-Clock 시간** | **`90.10 ms`** | **`85.93 ms`** | `< 60,000 ms` (서버리스 타임아웃) | **PASS** |
| **정상 SSE 완주 성공률** | **`16 / 16 (100%)`** | **`12 / 12 (100%)`** | `100%` (`data: [DONE]` 확인) | **PASS** |
| **지연시간 분포 (`Min / p50 / p95 / Max`)** | `84.04 / 86.26 / 89.45 / 89.45 ms` | `83.06 / 84.40 / 85.33 / 85.33 ms` | 무교착 · 일관된 응답성 | **PASS** |
| **스트리밍 중 클라이언트 강제 중단 (`499`)** | `2 / 2` 즉시 `cancel()` 및 리스 반납 | — | 좀비 세마포어 리스 `0건` | **PASS** |
| **형제 파산 키(`k2-dead-b`) 낭비 호출** | **`0 건`** (`acc-bankrupt` 계정 단위 즉시 차단) | **`0 건`** | 계정 단위 Fast-Break 작동 | **PASS** |
| **종료 후 ZSET 활성 리스 합계 (`ZCARD`)** | **`0`** | **`0`** | 정확히 `0` (Zero Leak) | **PASS** |
| **강제 GC 전후 프로세스 힙 메모리** | 실행 전 `24.16 MB` | 실행·GC 후 `31.74 MB` (`+7.58 MB` 런타임 버퍼 안정 수렴, 누수 없음) | 비정상 폭증·OOM 없음 | **PASS** |

> **프로덕션 라이브 헬스체크 (무부하 단일 GET 2회)**:
> - `GET https://my-server-mocha.vercel.app/v1/healthz` → `HTTP 200` (`"OK"`, 콜드 스타트 `1,528.50 ms`)
> - `GET https://my-server-mocha.vercel.app/v1/heartbeat` → `HTTP 200` (`{"status":"alive","node":"v24.22.2","region":"iad1","commitSha":"cb5f128"}`, 웜 응답 `269.51 ms`)

---

## 3. R2: 적대적 보안 감사 결과 및 즉시 패치 내역

### 3.1 금일(2026-11-16) 적발 즉시 패치한 방어선 취약점 (5건)

1. **[치명적] 프런트엔드 마크다운 렌더러 호스트 페이지 DOM XSS 차단 (`tokki-widget/lib/utils/sanitize-url.ts`, `lib/components/MarkdownPreview.tsx`)**
   - **원인**: `@uiw/react-markdown-preview@5.1.1`은 내부적으로 `rehype-raw`를 활성화하면서도 `rehype-sanitize`를 포함하지 않고 `defaultUrlTransform = url => url`을 기본 사용하여, iframe 없이 호스트 DOM(`#cx-shell`)에 직접 마운트되는 위젯 특성상 `<script>`, `<svg onload=...>`, `<iframe>`, `<img onerror=...>`, `[링크](javascript:alert(1))` 페이로드가 그대로 호스트 페이지에서 실행될 수 있었다.
   - **패치**: 제어문자·공백 난독화까지 제거 후 프로토콜을 검증하는 `sanitizeMarkdownUrl()` 및 `sanitizeHttpUrl()` 유틸리티를 신설하고, `MarkdownPreview.tsx`에 `urlTransform`, 안전한 태그 화이트리스트(`ALLOWED_HTML_TAGS` — `script`, `svg`, `math`, `iframe`, `object`, `embed`, `style`, `form` 등 원천 차단), `rehypeRewrite`(`on*` 이벤트 핸들러, `srcdoc`, `formaction`, 위험 `href`/`src` 속성 제거 및 외부 링크 `rel="noopener noreferrer"` 강제)를 적용했다.
2. **프런트엔드 `FunctionCall.tsx` 비정상 URI 스킴(`javascript:`/`data:`) 인젝션 차단 (`tokki-widget/lib/components/FunctionCall.tsx`)**
   - **원인**: WHATWG `new URL("javascript:alert(1)")`은 문법상 유효한 URL 객체를 반환하므로 `[[FUNCTION-CALL]] web-search (javascript:alert(1)) [[/FUNCTION-CALL]]` 구문이 클릭 가능한 `<a href="javascript:alert(1)">` 인용 링크로 렌더링되었다.
   - **패치**: `new URL()` 파싱 전에 `sanitizeHttpUrl(url)`을 선행 호출하여 오직 유효한 호스트명을 가진 `http:` / `https:` URL만 렌더링하도록 제한했다.
3. **`Content-Length` 콤마 스머글링 및 `/v2/admin/widgets/upload-icon` Chunked `>2MB` 스트리밍 우회 차단 (`my-server-test/src/app.ts`)**
   - **원인**: `Number.parseInt("10, 2097152", 10)`가 앞선 `10`만 파싱하여 프록시 다중 헤더 결합 시 `onRequest` 1MB/2MB 사전 차단을 우회할 수 있었고, `Content-Length`를 생략한 `Transfer-Encoding: chunked` 멀티파트 업로드가 `onParse` 바이트 상한 없이 메모리에 버퍼링되었다.
   - **패치**: `Content-Length` 헤더를 콤마 단위로 분리 검증하여 음수/비숫자 및 상충 복수 값(`10, 20`)은 RFC 9112 §6.3에 따라 `HTTP 400`, 한도 초과 값은 즉시 `HTTP 413`으로 차단했으며, `readBoundedBodyBytes()`를 도입해 Chunked 멀티파트 스트림도 `2MB`(`2,097,152 bytes`) 초과 즉시 스트림을 취소하고 `HTTP 413`을 반환하도록 봉쇄했다.
4. **업스트림 비재시도 4xx 에러 시 빈 `200 SSE` 오반환 수정 및 `/v2/widget/view` `null` 스키마 호환성 보강 (`my-server-test/lib/llm/rotating-provider.ts`, `src/endpoints/v2/widget-endpoints.ts`)**
   - **원인**: 업스트림(OpenRouter)이 비재시도 클라이언트 오류(`400`/`413` 등)를 반환할 때 `preStreamHandshake`가 예외를 던지지 않고 통과시켜 `/v2/ask`가 빈 `HTTP 200 text/event-stream`(`data: [DONE]`)을 반환하는 무응답 현상이 있었고, `/v2/widget/view`에 `{ widgetId: null, threadId: null }` 전달 시 `422` 에러가 발생했다.
   - **패치**: `!handshake.response.ok` 시 `KeyManagerError(..., "UPSTREAM_CLIENT_ERROR")`를 즉시 발생시켜 스트림 헤더 커밋 전에 `HTTP 413` 또는 `HTTP 502` JSON 에러로 정확히 응답하도록 수정하고, `/v2/widget/view` 스키마에 `t.Null()` 유니온을 허용했다.
5. **`402` 파산 계정 크레딧 충전 후 `resetKeyToActive()` 복구 불능 교착 패치 (`my-server-test/lib/llm/key-manager/stores/memory.ts`, `upstash-redis.ts`)**
   - **원인**: `402` 발생 시 계정 단위로 설정되는 24시간 `brokenAccounts` 플래그(`openrouter:account:<accountId>:broken`)가 `resetKeyToActive(keyId)` 호출 시 함께 삭제되지 않아, 운영자가 키를 수동 복구해도 24시간 동안 `reserveKey()` 선택에서 계속 배제되었다.
   - **패치**: `MemoryKeyStore`와 `UpstashRedisKeyStore` 양쪽의 `resetKeyToActive()`에서 계정 단위 `broken` 플래그를 즉시 함께 해제하도록 수정했다.

### 3.2 실시간 `curl` 적대적 보안 경계 검증 로그 (16개 공격·경계 벡터 전량 통과)

| 벡터 ID | 실측 공격·경계 시나리오 (`/usr/bin/curl`) | 기대 상태 | 실측 상태 | 응답 본문 요약 | 소요 시간 | 판정 |
| :---: | :--- | :---: | :---: | :--- | :---: | :---: |
| `V01` | `POST /v2/ask` — `widgetId` 필드 누락 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `10.65 ms` | **PASS** |
| `V02` | `POST /v2/ask` — 미등록 `widgetId` 변조 (`"evil-spoof-widget-999"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `8.03 ms` | **PASS** |
| `V03` | `POST /v2/ask` — SQL 인젝션 `widgetId` (`"' OR '1'='1"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.95 ms` | **PASS** |
| `V04` | `POST /v2/ask` — 초장문 `widgetId` (500자, DB 무조회 즉시 거부) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.50 ms` | **PASS** |
| `V05` | `POST /v2/widget/create-thread` — 미등록 `widgetId` 스레드 발급 시도 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id"}` | `7.51 ms` | **PASS** |
| `V06` | `POST /v2/ask` — 정상 최대 경계값 `message` 정확히 `4,000자` | `200` | **`200`** | `data: 토키%20 ... data: [DONE]` (정상 SSE 스트리밍) | `76.65 ms` | **PASS** |
| `V07` | `POST /v2/ask` — 경계 초과 `message` `4,001자` | `413` | **`413`** | `{"success":false,"error":"message too long (4001 > 4000 chars)"}` | `7.62 ms` | **PASS** |
| `V08` | `POST /v2/ask` — `50,000자` 한글 토큰 폭탄 (Token Bomb) | `413` | **`413`** | `{"success":false,"error":"message too long (50000 > 4000 chars)"}` | `6.93 ms` | **PASS** |
| `V09` | `POST /v2/ask` — `browserInfo` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"browserInfo too large (2509 > 2000 chars)"}` | `6.43 ms` | **PASS** |
| `V10` | `POST /v2/ask` — `threadId` 비문자열 중첩 객체 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2513 > 2000 chars)"}` | `5.75 ms` | **PASS** |
| `V11` | `POST /v2/ask` — Chunked + 대문자/OWS `APPLICATION/JSON ; charset=utf-8` 1.15MB 바디 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `7.09 ms` | **PASS** |
| `V12` | `POST /v2/ask` — `Content-Length > 1MB` (1.15MB 바디 헤더 선차단) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.74 ms` | **PASS** |
| `V13` | `POST /v2/ask` — 상충 복수 `Content-Length: 10, 2097152` 스머글링 차단 (RFC 9112 §6.3) | `400` / `413` | **`400`** | 소켓 HTTP 파서 계층 `400` 즉시 차단 + 프록시 정규화 시 `onRequest` `413` 이중 방어 | `5.38 ms` | **PASS** |
| `V14` | `POST /v2/admin/widgets/upload-icon` — Chunked `2.35MB` 멀티파트 스트림 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 2MB limit"}` | `8.07 ms` | **PASS** |
| `V15` | `POST /v2/widget/view` — `widgetId: null, threadId: null` 고아 스레드 무생성 검증 | `200` | **`200`** | `{"success":true,"thread_id":"",...}` (DB 고아 스레드 생성 `0건`) | `6.08 ms` | **PASS** |
| `V16` | `POST /v2/ask` — 동일 IP 분당 10회 초과 폭주 방어 (11번째 요청) | `429` | **`429`** | `{"success":false,"error":"Too Many Requests",...,"retryAfter":60}` | `4.55 ms` | **PASS** |

---

## 4. R3: 자동화 무결성 검증 및 프리플라이트 빌드 결과

### 4.1 테스트 스위트 실행 결과 (`bun test`)

| 저장소 | 테스트 파일 수 | 통과 / 실패 | `expect()` 단언문 수 | 실행 시간 | 종료 코드 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`my-server-test` (백엔드)** | 13개 파일 | **`295 PASS / 0 FAIL`** | `1,833`개 | `5.10s` | `0` |
| **`tokki-widget` (프런트엔드)** | 2개 파일 | **`33 PASS / 0 FAIL`** | `136`개 | `0.20s` | `0` |
| **합계** | **15개 파일** | **`328 PASS / 0 FAIL` (100%)** | **`1,969`개** | **`5.30s`** | **`0`** |

### 4.2 로컬 프리플라이트 빌드 검증

- **백엔드 번들 동기화 (`my-server-test`)**:
  - `npm run bundle:api` → 7개 SQL 마이그레이션 인라인(`src/generated-migrations.ts`) 및 단일 서버리스 번들 `api/index.js` (`26.9MB`, Node 24 CJS) 빌드 성공 (`112ms`).
  - Node.js CJS 핸들러 스모크 검증 (`require("./api/index.js").default` → `GET /v1/healthz`) → `HTTP 200 OK` 정상 반환 확인.
- **프런트엔드 타입체크 및 프로덕션 번들 빌드 (`tokki-widget`)**:
  - `npm run type-check` (`tsc`) → 타입 오류 `0건`.
  - `npm run build` (라이브러리 빌드 + `.d.ts` 생성) → `dist/` 정상 생성 (`2.65s`).
  - `npm run build:embed` (임베드 단일 스크립트 빌드) → `dist-embed/tokki.js` 및 `public/embed/tokki.js` (`2,131.30 kB` / gzip `624.08 kB`) 동기화 완료 (`2.04s`).
  - `npm run export-playground` (플레이그라운드 번들 빌드) → `export-playground/main.js` 정상 생성 (`2.45s`).

---

## 5. 수락 기준(Acceptance Criteria) 최종 점검표

- [x] **[성능 및 방어 무결성]** 제어된 동시 요청(18건 + 12건) 및 HTTP 429/402 오류 주입 환경에서 교착 상태나 메모리·세마포어 누수(`ZCARD = 0`) 없이 **100% 페일오버**를 달성했는가? → **달성 완료 (`90.10 ms` / `85.93 ms`, 완주율 100%, 형제 파산 키 호출 `0건`, `ZCARD = 0`)**
- [x] **[보안 경계 입증]** 악의적 `widgetId` 변조(`HTTP 403`) 및 초대형 페이로드·토큰 폭탄 공격(`HTTP 413`) 차단이 실측 로그로 입증되었는가? → **16개 실전 `curl` 벡터 전량 통과(`16/16 PASS`) 및 5건의 심층 우회 취약점 즉시 패치 완료**
- [x] **[최종 산출물]** 한국어 감사 보고서(`stress_test_audit.md`)가 생성되었는가? → **양쪽 워크스페이스(`my-server-test`, `tokki-widget`)에 한국어로 생성 완료**
- [x] **[테스트 무결성]** 모든 방어 테스트(`bun test`)가 종료 코드 `0`으로 100% 통과했는가? → **`328 / 328 PASS` (`1,969` assertions, `Exit Code 0`)**
- [x] **[쿼터 보호]** 커밋 메시지에 `[skip ci]`가 포함되어 Vercel 및 GitHub Actions 무료 쿼터를 보호했는가? → **`fix(tokki): automated defense and load test patch [skip ci]` 로컬 커밋 적용 완료 (무료 배포 쿼터 보호를 위해 불필요한 원격 푸시 생략)**
