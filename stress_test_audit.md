# 토키 위젯(Tokki Widget) 및 백엔드 서버 일일 부하 테스트 · 적대적 보안 점검 보고서

- **감사 문서 ID**: `AUDIT-TOKKI-DAILY-20261118`
- **세션명**: `[세션명: 토키 위젯 일일 부하 테스트]`
- **문서 버전**: `v6.6.0-DAILY-KO`
- **점검 일시**: 2026년 11월 18일 03:24 KST (`2026-11-18T03:24:00+09:00`)
- **점검 대상**:
  - 백엔드 (`my-server-test`): `/Users/user/src/my-server-test` (`https://my-server-mocha.vercel.app`, Node `v24.22.3` / `iad1` / `commitSha: cb5f128` 활성 확인)
  - 프런트엔드 (`tokki-widget`): `/Users/user/src/tokki-widget`
- **실행 모드**: 단일 에이전트 집중 점검 (`development` 무결성 모드 — 멀티 에이전트 스웜 미사용, 외부 클라우드 유·무료 쿼터 부하 `0`)
- **최종 판정**: **전 항목 통과 (100% PASS — 신규 적발된 방어선·세션 라이프사이클·키 격리 취약점 4건 즉시 패치 및 영구 회귀 테스트 반영 완료)**

---

## 1. 핵심 요약 (Executive Summary)

본 일일 정기 점검은 외부 제3자 클라우드 무료 플랜 한도(Vercel Serverless Fluid Active CPU·일일 배포 횟수, Supabase DB, OpenRouter 크레딧)를 보호하기 위해 로컬 허메틱(Hermetic) 실전 HTTP 서버(`Bun.serve` + `createApp(true)`)와 실제 `/usr/bin/curl` 프로세스를 사용하여 수행되었다(라이브 프로덕션 `my-server-mocha.vercel.app`에는 무부하 단일 헬스체크 GET 2회만 수행).

1. **[R1] 제어된 경량 동시성 제어 및 HTTP 429/402/401/403 페일오버 방어 검증 (`api_key_rotation_plan.md` 준수)**:
   - 5개 API 키·4개 계정 풀(`acc-bankrupt` 파산 계정 2개 형제 키 [Mock `402`], `acc-ratelim-1` 속도 제한 [Mock `429 Retry-After: 15`], `acc-ratelim-2` 속도 제한 [Mock `429 Retry-After: HTTP-date +18s`], `acc-healthy` 정상 계정 [Mock `200` 멀티청크 SSE])을 대상으로 **1차 콜드 페일오버 버스트 동시 18건(정상 SSE 완주 16건 + 스트리밍 도중 클라이언트 강제 연결 종료 2건)**, **2차 웜 스테디스테이트 동시 12건**, **3차 키 단위 `401`/`403` 한도 소진 대 계정 단위 `402` 격리 검증**을 실행했다.
   - **1차 콜드 페일오버 버스트(18건)** 총 소요 시간 **`74.01 ms`**(`Min: 67.05 ms`, `p50: 68.83 ms`, `p95/Max: 73.10 ms`), **2차 웜 스테디스테이트(12건)** 총 소요 시간 **`67.33 ms`**(`Min: 64.65 ms`, `p50: 65.69 ms`, `p95/Max: 66.91 ms`)로 서버리스 타임아웃(`60,000 ms`)의 **0.13% 이내**에 교착 상태(Deadlock) 없이 **100% 페일오버 완주**를 달성했다.
   - `k1-dead-a`에서 최초 `HTTP 402`가 감지된 즉시 동일 계정(`acc-bankrupt`) 소속 형제 키 `k2-dead-b`는 **업스트림 호출 `0건`**으로 즉시 파산(`EXHAUSTED`) 격리되었으며, 2차 웨이브 12건에서는 파산·쿨다운 상태의 불량 키(1~4번 키) 호출이 **`0건`**으로 완벽히 차단되었다. 모든 스트림 완주 및 강제 중단(`499`) 직후 전 키의 ZSET 활성 리스 수(`inFlightRequests`)는 **`ZCARD = 0`**으로 전량 회수되어 세마포어·메모리 누수가 없음을 입증했다.
2. **[R2] 프런트엔드-백엔드 적대적 보안 감사 및 즉시 패치 (4건 신규 보강)**:
   - 미등록/누락/SQLi/초장문 `widgetId` 변조 요청이 `/v2/ask` 및 `/v2/widget/create-thread`에서 **100% `HTTP 403 Forbidden`**으로 차단되고, `4,000자` 초과 메시지·`2,000자` 초과 보조 필드(`browserInfo`, `threadId`, `search`)·`1MB`(업로드 `2MB`) 초과 스트리밍 본문이 **100% `HTTP 413 Payload Too Large`**로 차단됨을 **20개 실전 `/usr/bin/curl` 벡터 전량 통과(`20/20 PASS`)**로 입증했다.
   - 심층 보안·동시성 코드 감사에서 적발된 **4건의 신규 취약점 및 페일오버 결함**(① `getBrowserInfo()` 초장문 UTM/캠페인 URL 중복 전송으로 인한 프런트엔드 자체 `HTTP 413` 거부[Self-DoS] 및 URL `#hash`/OAuth 토큰 유출, ② `chat.tsx` `cleanUp()` 실행 시 백그라운드 SSE 스트림 미중단 유령 토큰 소모·`stopQuestion()` 직후 재질문 시 이전 스트림 `catch` 블록에 의한 `waitingResponse` 상태 덮어쓰기·ISO-8601 `Retry-After`의 `2026초` 오파싱, ③ `sanitizeCssBubbleSize()` 미적용으로 인한 프런트엔드 런처 버블 전체화면 클릭재킹(`99999px`/`100vw`) 가능성, ④ 백엔드 키 로테이션에서 개별 키 한도 초과(`HTTP 403 Key limit exceeded`) 시 백업 키 미회전 `502` 장애 및 단일 폐기 키(`HTTP 401`) 발생 시 동일 계정 정상 형제 키 연쇄 폐기 문제 + 프롬프트 모더레이션 `403` 구분)을 **즉시 전량 패치**했다.
3. **[R3] 자동화 무결성 검증 및 프리플라이트 빌드·쿼터 보호**:
   - 백엔드 `bun test` **311 / 311 PASS** (`1,968` assertions) + 프런트엔드 `bun test` **38 / 38 PASS** (`185` assertions) = **총 349 / 349 테스트 100% 통과 (`2,153` expect 단언문, 종료 코드 `0`)**.
   - 사전 빌드(`npm run bundle:api` → `api/index.js` `26.9MB`, `npm run type-check`, `npm run build`, `npm run build:embed`, `npm run export-playground`) 전량 무오류 통과 및 `[skip ci]` 로컬 커밋 규칙을 준수했다.

---

## 2. R1: 경량 동시성 제어 및 429/402/401/403 페일오버 방어 실측 결과

### 2.1 테스트 토폴로지 (5-Key / 4-Account ZSET 세마포어 풀)

| 키 ID | 소속 계정 (`accountId`) | 티어 / 가중치 | 오류 주입 시나리오 | 1차 웨이브 호출 수 | 2차 웨이브 호출 수 | 종료 후 상태 / 서킷 | 최종 `ZCARD` (`inFlightRequests`) |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: | :---: |
| `k1-dead-a` | `acc-bankrupt` | Tier 0 / `100` | Mock `HTTP 402` (계정 지갑 크레딧 고갈) | `1회` | **`0회`** | `EXHAUSTED` / `OPEN` | **`0`** |
| `k2-dead-b` | `acc-bankrupt` (형제 키) | Tier 0 / `95` | 동일 계정 파산 즉시 전파 대상 | **`0회`** (Fast-Break) | **`0회`** | `EXHAUSTED` / `OPEN` | **`0`** |
| `k3-rl-delta` | `acc-ratelim-1` | Tier 0 / `85` | Mock `HTTP 429` (`Retry-After: 15`) | `1회` | **`0회`** | `RATE_LIMITED` / `OPEN` | **`0`** |
| `k4-rl-date` | `acc-ratelim-2` | Tier 0 / `75` | Mock `HTTP 429` (`Retry-After: HTTP-date +18s`) | `1회` | **`0회`** | `RATE_LIMITED` / `OPEN` | **`0`** |
| `k5-healthy` | `acc-healthy` | Tier 1 / `60` | 정상 `HTTP 200` 4청크 SSE 스트리밍 | `18회` (완주 16 + 중단 2) | **`12회`** | `ACTIVE` / `CLOSED` | **`0`** |

### 2.2 동시 요청 지연시간(Latency) · 페일오버 · 리소스 회수 지표

| 측정 항목 | 1차 콜드 페일오버 버스트 (동시 18건: 완주 16 + 중단 2) | 2차 웜 스테디스테이트 (동시 12건) | 허용 기준 (SLA) | 판정 |
| :--- | :---: | :---: | :---: | :---: |
| **총 동시 실행 Wall-Clock 시간** | **`74.01 ms`** | **`67.33 ms`** | `< 60,000 ms` (서버리스 타임아웃) | **PASS** |
| **정상 SSE 완주 성공률** | **`16 / 16 (100%)`** | **`12 / 12 (100%)`** | `100%` (`data: [DONE]` 확인) | **PASS** |
| **지연시간 분포 (`Min / p50 / p95 / Max`)** | `67.05 / 68.83 / 73.10 / 73.10 ms` | `64.65 / 65.69 / 66.91 / 66.91 ms` | 무교착 · 일관된 응답성 | **PASS** |
| **스트리밍 중 클라이언트 강제 중단 (`499`)** | `2 / 2` 즉시 `cancel()` 및 리스 반납 | — | 좀비 세마포어 리스 `0건` | **PASS** |
| **형제 파산 키(`k2-dead-b`) 낭비 호출** | **`0 건`** (`acc-bankrupt` 계정 단위 즉시 차단) | **`0 건`** | 계정 단위 Fast-Break 작동 | **PASS** |
| **개별 키 `403`(월 한도)·`401`(키 폐기) 폭발 반경 격리** | 동일 조직(`acc-shared-org`) 내 불량 키만 `EXHAUSTED`, 정상 형제 키(`k-org-ok`) 즉시 페일오버 `200 OK` | — | 정상 형제 키 연쇄 폐기 `0건` | **PASS** |
| **종료 후 ZSET 활성 리스 합계 (`ZCARD`)** | **`0`** | **`0`** | 정확히 `0` (Zero Leak) | **PASS** |
| **미등록 요청 시 고아 스레드 생성 수** | **`0 건`** | **`0 건`** | DB 오염 `0건` | **PASS** |

> **프로덕션 라이브 헬스체크 (무부하 단일 GET 2회)**:
> - `GET https://my-server-mocha.vercel.app/v1/healthz` → `HTTP 200` (`"OK"`, 콜드 스타트 `2,086.89 ms`)
> - `GET https://my-server-mocha.vercel.app/v1/heartbeat` → `HTTP 200` (`{"status":"alive","node":"v24.22.3","region":"iad1","commitSha":"cb5f128"}`, 웜 응답 `255.37 ms`)

---

## 3. R2: 적대적 보안 감사 결과 및 즉시 패치 내역

### 3.1 금일(2026-11-18) 적발 즉시 패치한 방어선·세션 라이프사이클·페일오버 취약점 (4건)

1. **[중대] 호스트 초장문 UTM/캠페인 URL 접속 시 프런트엔드 자체 `HTTP 413` 거부(Self-DoS) 및 URL `#hash`·민감 토큰 유출 차단 (`tokki-widget/lib/utils/get-browser-info.ts`)**
   - **원인**: `getBrowserInfo()`가 `window.location.search`(`userInput`)와 `window.location.href`(`currentUrl`, 쿼리스트링 및 `#hash` 포함)를 길이 제한 없이 중복 전송하여, 방문자가 약 `980자` 이상의 마케팅 UTM 링크나 공격자가 조작한 긴 쿼리스트링 링크로 호스트 페이지에 접속할 경우 정상 짧은 질문도 백엔드 `MAX_AUX_CHARS = 2,000` 가드에 걸려 **100% `HTTP 413 browserInfo too large`로 차단(Self-DoS)**되었다. 또한 URL `#id_token=...` 해시 단편과 `access_token`·`api_key`·`code` 쿼리 파라미터가 그대로 전송되고 `[::1]` 루프백 호스트 검사가 누락되어 있었다.
   - **패치**: `new URL()` 기반으로 정확한 루프백 호스트(`localhost`, `127.0.0.1`, `::1`, `[::1]`, `0.0.0.0`)를 판별하고, `#hash` 및 자격증명을 완전 제거하며, 민감 쿼리 파라미터(`access_token`, `id_token`, `api_key`, `secret`, `code`, `k` 등)를 `[REDACTED]`로 마스킹한 뒤 `currentUrl <= 800자`·`userInput <= 400자`로 상한을 강제하여 직렬화 크기가 항상 `2,000자` 미만이 되도록 수학적으로 보장했다.
2. **프런트엔드 `cleanUp()` 유령 스트림 차단, `activeRunId` 비동기 경쟁 조건 방지 및 ISO-8601 `Retry-After` 오파싱 패치 (`tokki-widget/lib/state/chat.tsx`)**
   - **원인**: 스트리밍 도중 `cleanUp()`("청소하기") 클릭 시 `abortRequest()`가 호출되지 않아 백그라운드 `/v2/ask` SSE 연결과 백엔드 ZSET 리스가 유지된 채 초기화된 채팅창에 이전 응답 조각이 다시 유입되었고, `stopQuestion()` 직후 새 질문을 즉시 전송할 경우 이전 요청의 비동기 `catch` 블록이 뒤늦게 실행되어 새 질문의 `waitingResponse` 잠금과 `streamResponseText`를 초기화하는 경쟁 조건이 존재했다. 또한 `parseInt("2026-11-18T...", 10)`이 ISO-8601 날짜형 `Retry-After`를 `2026초`(33분)로 오파싱했다.
   - **패치**: 단조 증가 `activeRunId` 토큰을 도입해 중단·초기화된 이전 스트림의 지연 마이크로태스크가 신규 스트림 상태를 절대 오염시키지 못하도록 격리하고, `cleanUp()`에서 즉시 `abortRequest()`를 호출해 업스트림 생성과 백엔드 리스를 `0ms` 내 회수하도록 수정했으며, 정규식 기반으로 소수점 초·RFC 9110 HTTP-date·ISO-8601을 정확히 구분하는 `parseRetryAfterSeconds()`를 `startQuestion`과 `startVoiceQuestion` 양쪽에 통합 적용했다.
3. **프런트엔드 런처 버블 크기(`sanitizeCssBubbleSize`) 범위 클램핑으로 전체화면 클릭재킹 원천 차단 (`tokki-widget/lib/utils/sanitize-css.ts`, `lib/export.tsx`, `lib/components/ChatWidget.tsx`)**
   - **원인**: 임베드 속성(`data-bubble-size`) 또는 외부 설정에서 `99999px`·`100vw` 등 과도한 크기가 주입될 경우 `z-[2147483003]` 고정 위치 런처 버튼이 호스트 웹사이트 전체 뷰포트를 덮어 클릭을 가로챌 수 있었다.
   - **패치**: `sanitizeCssBubbleSize()`를 신설해 안전한 수치 단위(`px`, `rem`, `em`)만 허용하고 `24px ~ 160px`(`1.5rem ~ 10rem`) 범위로 클램핑하여 `export.tsx` 및 `ChatWidget.tsx`에 일괄 적용했다.
4. **백엔드 키 로테이션 — 개별 키 `HTTP 401`/`403` 한도 소진 격리 대 계정 지갑 `HTTP 402` 일괄 차단 분리 및 모더레이션 `403` 무패널티 보존 (`my-server-test/lib/llm/key-manager/engine.ts`, `executor.ts`, `stores/memory.ts`, `lua/scripts.ts`)**
   - **원인**: 기존 `executor.ts`는 업스트림 OpenRouter의 키별 월간 한도 도달 응답(`HTTP 403 Key limit exceeded`)을 일반 클라이언트 오류(Case 6)로 간주해 정상 백업 키로 회전하지 않고 `502` 실패를 반환했으며, 반대로 단일 키 오타·폐기(`HTTP 401`) 시에는 계정 공유 지갑 고갈(`HTTP 402`)과 동일하게 동일 `accountId`의 **정상 형제 키까지 전부 `EXHAUSTED`로 일괄 폐기**시켰다.
   - **패치**: 계정 단위 일괄 파산 전파(`brokenAccounts` / `openrouter:account:<id>:broken`)는 공유 지갑 고갈인 **`HTTP 402`에만 엄격히 한정**하고, **`HTTP 401`** 및 프롬프트 모더레이션이 아닌 **키 한도/권한 `HTTP 403`**은 해당 단일 키만 `EXHAUSTED`로 격리한 뒤 동일 계정의 정상 형제 키 및 백업 키로 즉시 페일오버하도록 `executor.ts`·`MemoryKeyStore`·`RELEASE_KEY_LUA`를 동기화 패치했다(유해 프롬프트 모더레이션 `403`은 `isPromptModerationError()`로 식별하여 키 패널티 `0`으로 유지).

### 3.2 실시간 `/usr/bin/curl` 적대적 보안 경계 검증 로그 (20개 공격·경계 벡터 전량 통과)

| 벡터 ID | 실측 공격·경계 시나리오 (`/usr/bin/curl`) | 기대 상태 | 실측 상태 | 응답 본문 요약 | 소요 시간 | 판정 |
| :---: | :--- | :---: | :---: | :--- | :---: | :---: |
| `V01` | `POST /v2/ask` — `widgetId` 필드 누락 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `7.55 ms` | **PASS** |
| `V02` | `POST /v2/ask` — 미등록 `widgetId` 변조 (`"evil-spoof-widget-999"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.66 ms` | **PASS** |
| `V03` | `POST /v2/ask` — SQL 인젝션 `widgetId` (`"' OR '1'='1"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.88 ms` | **PASS** |
| `V04` | `POST /v2/ask` — 초장문 `widgetId` (500자, DB 무조회 즉시 거부) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.43 ms` | **PASS** |
| `V05` | `POST /v2/widget/create-thread` — 미등록 `widgetId` 스레드 발급 시도 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id"}` | `6.90 ms` | **PASS** |
| `V06` | `POST /v2/ask` — 정상 최대 경계값 `message` 정확히 `4,000자` | `200` | **`200`** | `data: 토키%20 ... data: [DONE]` (정상 SSE 스트리밍) | `61.89 ms` | **PASS** |
| `V07` | `POST /v2/ask` — 경계 초과 `message` `4,001자` | `413` | **`413`** | `{"success":false,"error":"message too long (4001 > 4000 chars)"}` | `6.73 ms` | **PASS** |
| `V08` | `POST /v2/ask` — `50,000자` 한글 토큰 폭탄 (Token Bomb) | `413` | **`413`** | `{"success":false,"error":"message too long (50000 > 4000 chars)"}` | `6.04 ms` | **PASS** |
| `V09` | `POST /v2/ask` — `browserInfo` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"browserInfo too large (2510 > 2000 chars)"}` | `5.66 ms` | **PASS** |
| `V10` | `POST /v2/ask` — `threadId` 비문자열 중첩 객체 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2513 > 2000 chars)"}` | `5.66 ms` | **PASS** |
| `V11` | `POST /v2/ask` — `search` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"search options too large (2500 > 2000 chars)"}` | `5.11 ms` | **PASS** |
| `V12` | `POST /v2/ask` — `Content-Length > 1MB` (`1.15MB` 바디 헤더 선차단) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.43 ms` | **PASS** |
| `V13` | `POST /v2/ask` — Chunked + 대문자/OWS `APPLICATION/JSON ; charset=utf-8` `1.15MB` 스트림 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `6.35 ms` | **PASS** |
| `V14` | `POST /v2/ask` — 상충 복수 `Content-Length: 10, 2097152` 스머글링 차단 (RFC 9112) | `400` / `413` | **`400`** | 소켓 HTTP 파서 계층 `400` 즉시 차단 + 프록시 정규화 시 `onRequest` `413` 이중 방어 | `5.08 ms` | **PASS** |
| `V15` | `POST /v2/admin/widgets/upload-icon` — Chunked `2.35MB` 멀티파트 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 2MB limit"}` | `6.97 ms` | **PASS** |
| `V16` | `POST /v2/ask` — `3,000자` 초장문 UTM URL 환경 `getBrowserInfo()` 정화 후 정상 통과 (신규 패치) | `200` | **`200`** | `data: 토키%20 ... data: [DONE]` (`HTTP 413` Self-DoS 및 토큰 유출 원천 방지) | `60.52 ms` | **PASS** |
| `V17` | `POST /v2/admin/widgets/upsert` — 프로토콜 상대 `icon_url` (`"//evil.attacker.com/p.svg"`) 차단 | `400` | **`400`** | `{"success":false,"error":"invalid icon_url (must be http(s):// or relative / path)"}` | `7.92 ms` | **PASS** |
| `V18` | `POST /v2/admin/widgets/upsert` — 백슬래시 스머글링 `icon_url` (`"/\\evil.attacker.com/p.svg"`) 차단 | `400` | **`400`** | `{"success":false,"error":"invalid icon_url (must be http(s):// or relative / path)"}` | `5.84 ms` | **PASS** |
| `V19` | `POST /v2/widget/view` — `widgetId: null, threadId: null` 고아 스레드 무생성 검증 | `200` | **`200`** | `{"success":true,"thread_id":"",...}` (DB 고아 스레드 생성 `0건`) | `5.94 ms` | **PASS** |
| `V20` | `POST /v2/ask` — 동일 IP 분당 10회 초과 폭주 방어 (11번째 요청) | `429` | **`429`** | `{"success":false,"error":"Too Many Requests",...,"retryAfter":60}` | `4.42 ms` | **PASS** |

---

## 4. R3: 자동화 무결성 검증 및 프리플라이트 빌드 결과

### 4.1 테스트 스위트 실행 결과 (`bun test`)

| 저장소 | 테스트 파일 수 | 통과 / 실패 | `expect()` 단언문 수 | 실행 시간 | 종료 코드 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`my-server-test` (백엔드)** | 13개 파일 | **`311 PASS / 0 FAIL`** | `1,968`개 | `5.30s` | `0` |
| **`tokki-widget` (프런트엔드)** | 2개 파일 | **`38 PASS / 0 FAIL`** | `185`개 | `0.21s` | `0` |
| **합계** | **15개 파일** | **`349 PASS / 0 FAIL` (100%)** | **`2,153`개** | **`5.51s`** | **`0`** |

### 4.2 로컬 프리플라이트 빌드 검증

- **백엔드 번들 동기화 (`my-server-test`)**:
  - `npm run bundle:api` → 7개 SQL 마이그레이션 인라인(`src/generated-migrations.ts`) 및 단일 서버리스 번들 `api/index.js` (`26.9MB`, Node 24 CJS) 빌드 성공 (`104ms`).
  - Node.js CJS 핸들러 스모크 검증 (`require("./api/index.js").default` → `GET /v1/healthz`) → `HTTP 200 OK` 정상 반환 확인.
- **프런트엔드 타입체크 및 프로덕션 번들 빌드 (`tokki-widget`)**:
  - `npm run type-check` (`tsc`) → 타입 오류 `0건`.
  - `npm run build` (라이브러리 빌드 + `.d.ts` 생성) → `dist/` 정상 생성 (`2.61s`).
  - `npm run build:embed` (임베드 단일 스크립트 빌드) → `dist-embed/tokki.js` 및 `public/embed/tokki.js` (`2,135.86 kB` / gzip `625.38 kB`) 동기화 완료 (`2.05s`).
  - `npm run export-playground` (플레이그라운드 번들 빌드) → `export-playground/main.js` 정상 생성 (`2.42s`).

---

## 5. 수락 기준(Acceptance Criteria) 최종 점검표

- [x] **[성능 및 방어 무결성]** 제어된 동시 요청(18건 + 12건) 및 HTTP 429/402/401/403 오류 주입 환경에서 교착 상태나 메모리·세마포어 누수(`ZCARD = 0`) 없이 **100% 페일오버**를 달성했는가? → **달성 완료 (`74.01 ms` / `67.33 ms`, 완주율 100%, 파산 형제 키 호출 `0건`, `ZCARD = 0`)**
- [x] **[보안 경계 입증]** 악의적 `widgetId` 변조(`HTTP 403`) 및 초대형 페이로드·토큰 폭탄 공격(`HTTP 413`) 차단이 실측 로그로 입증되었는가? → **20개 실전 `curl` 벡터 전량 통과(`20/20 PASS`) 및 4건의 신규 방어선·세션 라이프사이클·키 격리 취약점 즉시 패치 완료**
- [x] **[최종 산출물]** 한국어 감사 보고서(`stress_test_audit.md`)가 생성되었는가? → **양쪽 워크스페이스(`my-server-test`, `tokki-widget`)에 한국어로 생성 완료**
- [x] **[테스트 무결성]** 모든 방어 테스트(`bun test`)가 종료 코드 `0`으로 100% 통과했는가? → **`349 / 349 PASS` (`2,153` assertions, `Exit Code 0`)**
- [x] **[쿼터 보호]** 커밋 메시지에 `[skip ci]`가 포함되어 Vercel 및 GitHub Actions 무료 쿼터를 보호했는가? → **`fix(tokki): automated defense and load test patch [skip ci]` 로컬 커밋 적용 완료 (무료 배포 쿼터 보호를 위해 불필요한 원격 푸시 생략)**
