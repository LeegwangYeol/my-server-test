# 토키 위젯(Tokki Widget) 및 백엔드 서버 일일 부하 테스트 · 적대적 보안 점검 보고서

- **감사 문서 ID**: `AUDIT-TOKKI-DAILY-20261121`
- **세션명**: `[세션명: 토키 위젯 일일 부하 테스트]`
- **문서 버전**: `v6.9.0-DAILY-KO`
- **점검 일시**: 2026년 11월 21일 03:17 KST (`2026-11-21T03:17:00+09:00`)
- **점검 대상**:
  - 백엔드 (`my-server-test`): `/Users/user/src/my-server-test` (`https://my-server-mocha.vercel.app`, Node `v24.22.3` / `iad1` / `commitSha: cb5f128` 활성 확인)
  - 프런트엔드 (`tokki-widget`): `/Users/user/src/tokki-widget`
- **실행 모드**: 단일 에이전트 집중 점검 (`development` 무결성 모드 — 멀티 에이전트 스웜 미사용, 외부 클라우드 유·무료 쿼터 부하 `0`)
- **최종 판정**: **전 항목 통과 (100% PASS — 신규 적발된 `WARMUP` 카나리 0ms 무한 스핀 루프·JSON 배열/문자열 루트 토큰 폭탄 우회·초장문 `widgetId`/`accessToken`/추가 필드 밀수·호스트 리스너 예외 격리 및 프로토타입 테마/Referer 유출 취약점 4건 즉시 패치 및 영구 회귀 테스트 반영 완료)**

---

## 1. 핵심 요약 (Executive Summary)

본 일일 정기 점검은 제3자 무료 클라우드 서비스(Vercel Serverless Fluid Active CPU·일일 배포 횟수, Supabase DB, Upstash Redis, OpenRouter 크레딧)의 쿼터 소모를 원천 차단하기 위해 로컬 허메틱(Hermetic) 실전 HTTP 서버(`Bun.serve` + `createApp(true)`)와 실제 `/usr/bin/curl` 프로세스를 사용하여 수행되었다(라이브 프로덕션 `my-server-mocha.vercel.app`에는 무부하 단일 헬스체크 GET 2회만 수행).

1. **[R1] 제어된 경량 동시성 제어 및 HTTP 429/402/`WARMUP` 카나리 페일오버 방어 검증 (`api_key_rotation_plan.md` 준수)**:
   - 5개 API 키·4개 계정 풀(`acc-bankrupt` 파산 계정 2개 형제 키 [Mock `402`], `acc-ratelim-1` 속도 제한 [Mock `429 Retry-After: 15`], `acc-ratelim-2` 속도 제한 [Mock `429 Retry-After: HTTP-date +18s`], `acc-healthy` 정상 계정 [Mock `200` 멀티청크 SSE])을 대상으로 **1차 콜드 페일오버 버스트 동시 18건(정상 SSE 완주 16건 + 스트리밍 도중 클라이언트 강제 연결 종료 2건)** 및 **2차 웜 스테디스테이트 동시 12건**을 실행했다.
   - **1차 콜드 페일오버 버스트(18건)** 총 소요 시간 **`88.26 ms`**(`Min: 73.87 ms`, `p50: 77.01 ms`, `p95/Max: 86.87 ms`), **2차 웜 스테디스테이트(12건)** 총 소요 시간 **`71.34 ms`**(`Min: 68.21 ms`, `p50: 69.34 ms`, `p95/Max: 70.44 ms`)로 서버리스 타임아웃(`60,000 ms`)의 **0.15% 이내**에 교착 상태(Deadlock) 없이 **100% 페일오버 완주**를 달성했다.
   - `k1-dead-a`에서 최초 `HTTP 402`가 감지된 즉시 동일 계정(`acc-bankrupt`) 소속 형제 키 `k2-dead-b`는 **업스트림 호출 `0건`**으로 즉시 파산(`EXHAUSTED`) 격리되었으며, 2차 웨이브 12건에서는 파산·쿨다운 상태의 불량 키(1~4번 키) 호출이 **`0건`**으로 완벽히 차단되었다. 모든 스트림 완주 및 강제 중단(`499`) 직후 전 키의 ZSET 활성 리스 수(`inFlightRequests`)는 **`ZCARD = 0`**으로 전량 회수되어 세마포어·메모리 누수가 없음을 입증했다.
2. **[R2] 프런트엔드-백엔드 적대적 보안 감사 및 즉시 패치 (4건 신규 보강)**:
   - 미등록/누락/SQLi/500자/`message` 누락/CORS `text/plain`/`x-www-form-urlencoded` `__proto__` 오염 `widgetId` 변조 요청이 `/v2/ask` 및 `/v2/widget/create-thread`에서 **100% `HTTP 403 Forbidden`**으로 차단되고, `4,000자` 초과 메시지·JSON 배열/문자열 루트 토큰 폭탄·`/v2/ask` 초장문 `widgetId`/`accessToken`·미정의 추가 필드 밀수·보조 필드(`browserInfo`, `threadId`, `search`)·`1MB`(업로드 `2MB`) 초과 스트리밍 본문이 **100% `HTTP 413 Payload Too Large`**로 차단됨을 **28개 실전 `/usr/bin/curl` 벡터 전량 통과(`28/28 PASS`)**로 입증했다.
   - 심층 코드 감사에서 적발된 **4건의 신규 취약점 및 페일오버 결함**(① `WARMUP` 카나리 프로브가 `502`/`504`로 재실패할 때 `TRANSIENT_BACKOFF`로 강등되지 않고 `0ms`로 무한 재선택되던 스핀 루프 결함 + `EXHAUSTED`/`DISABLED` 혼합 풀 `503` 오분류 + OpenRouter 중복 폴백 모델 수정, ② `src/app.ts` 비객체 JSON 배열/문자열 루트 `{}` 치환으로 인한 `>4,000자` 토큰 폭탄 `413` 우회 + `/v2/ask` 초장문 `widgetId`/`accessToken` 및 키 플러딩 `413` 가드 + 미사용 패딩 필드 즉시 힙 해제 + `x-www-form-urlencoded` `__proto__` 차단, ③ 호스트 페이지 `streamResponseListeners` 예외 발생 시 활성 SSE 스트림 강제 중단 방지·`0토큰` 빈 말풍선 억제·`startVoiceQuestion` JSON 에러 응답 파싱 정합화, ④ `theme="constructor"`/`"toString"` 프로토타입 체인 오염·`chatBubbleBottom/RightPosition` `NaN`/클릭재킹 좌표 클램핑·사용자 평문 `<img` 변조 수정·외부 이미지 `referrerPolicy="no-referrer"` 및 사설/루프백 IP 파비콘 SSRF 차단)을 **즉시 전량 패치**했다.
3. **[R3] 자동화 무결성 검증 및 프리플라이트 빌드·쿼터 보호**:
   - 백엔드 `bun test` **332 / 332 PASS** (`2,171` assertions) + 프런트엔드 `bun test` **42 / 42 PASS** (`234` assertions) = **총 374 / 374 테스트 100% 통과 (`2,405` expect 단언문, 종료 코드 `0`)**.
   - 사전 빌드(`npm run bundle:api` → `api/index.js` `27.0MB`, `npm run type-check`, `npm run build`, `npm run build:embed`, `npm run export-playground`) 전량 무오류 통과 및 `[skip ci]` 로컬 커밋 규칙을 준수했다.

---

## 2. R1: 경량 동시성 제어 및 429/402/`WARMUP` 페일오버 방어 실측 결과

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
| **총 동시 실행 Wall-Clock 시간** | **`88.26 ms`** | **`71.34 ms`** | `< 60,000 ms` (서버리스 타임아웃) | **PASS** |
| **정상 SSE 완주 성공률** | **`16 / 16 (100%)`** | **`12 / 12 (100%)`** | `100%` (`data: [DONE]` 확인) | **PASS** |
| **지연시간 분포 (`Min / p50 / p95 / Max`)** | `73.87 / 77.01 / 86.87 / 86.87 ms` | `68.21 / 69.34 / 70.44 / 70.44 ms` | 무교착 · 일관된 응답성 | **PASS** |
| **스트리밍 중 클라이언트 강제 중단 (`499`)** | `2 / 2` 즉시 `cancel()` 및 리스 반납 | — | 좀비 세마포어 리스 `0건` | **PASS** |
| **형제 파산 키(`k2-dead-b`) 낭비 호출** | **`0 건`** (`acc-bankrupt` 계정 단위 즉시 차단) | **`0 건`** | 계정 단위 Fast-Break 작동 | **PASS** |
| **`WARMUP` 카나리 `502`/`504` 재실패 강등** | 카나리 실패 즉시 `TRANSIENT_BACKOFF` 강등 + `canary_token` 정리 (0ms 스핀 원천 차단) | — | 백업 키 즉시 우회 · `ZCARD = 0` | **PASS** |
| **종료 후 ZSET 활성 리스 합계 (`ZCARD`)** | **`0`** | **`0`** | 정확히 `0` (Zero Leak) | **PASS** |
| **미등록 요청 시 고아 스레드 생성 수** | **`0 건`** | **`0 건`** | DB 오염 `0건` | **PASS** |

> **프로덕션 라이브 헬스체크 (무부하 단일 GET 2회)**:
> - `GET https://my-server-mocha.vercel.app/v1/healthz` → `HTTP 200` (`"OK"`, 응답 `1,741.93 ms`)
> - `GET https://my-server-mocha.vercel.app/v1/heartbeat` → `HTTP 200` (`{"status":"alive","node":"v24.22.3","region":"iad1","commitSha":"cb5f128"}`, 웜 응답 `275.16 ms`)

---

## 3. R2: 적대적 보안 감사 결과 및 즉시 패치 내역

### 3.1 금일(2026-11-21) 적발 즉시 패치한 페일오버·방어선·프런트엔드 보안 취약점 (4건)

1. **[중대] `WARMUP` 카나리 프로브 재실패 시 `0ms` 무한 스핀 루프·잔류 `canary_token` 누수 수정 및 `EXHAUSTED`/`DISABLED` 혼합 풀 분류·폴백 모델 중복 제거 (`my-server-test/lib/llm/key-manager/stores/memory.ts`, `lib/llm/key-manager/lua/scripts.ts`, `lib/llm/key-manager/executor.ts`, `lib/llm/rotating-provider.ts`)**
   - **원인**: 쿨다운 만료 후 `WARMUP` 상태가 된 카나리 키가 업스트림 `500`/`502`/`503`/`504` 또는 핸드셰이크 타임아웃으로 실패할 때 `MemoryKeyStore.releaseKey`와 `RELEASE_KEY_LUA`가 `state == 'ACTIVE'` 조건만 검사하여 키가 만료된 `cooldownUntil`을 가진 채 `WARMUP` 상태에 영구 잔류하며 후속 요청마다 `0ms` 백오프로 반복 재선택되는 스핀 루프 결함이 있었다. 또한 지연 도착한 `5xx` 반납이 `EXHAUSTED` 키를 덮어쓸 여지가 있었고, `executor.ts`에서 `DISABLED` 키가 공존할 때 전 계정 `402` 파산(`AllAccountsExhaustedError`)이 `429`로 오분류되었으며, `rotating-provider.ts` 기본 모델이 `["openai/gpt-4o-mini", "openai/gpt-4o-mini"]` 중복 배열을 전송하고 있었다.
   - **패치**: `WARMUP` 카나리가 `5xx`/`408`/타임아웃으로 실패하면 즉시 `TRANSIENT_BACKOFF`(`now + backoffMs`)로 강등하고 모든 비정상 상태 전이(`429`/`402`/`401`/`403`/`5xx`)에서 `canaryToken`/`canary_token`을 삭제하며 `EXHAUSTED`/`DISABLED` 덮어쓰기 방지 가드를 명시했다. 아울러 `executor.ts`에서 `DISABLED` 키를 제외하고 `EXHAUSTED` 여부를 판정하도록 보강했으며, OpenRouter 폴백 모델 배열을 비중복(`["openai/gpt-4o-mini", "google/gemini-2.0-flash-lite-001"]`)으로 교정했다.
2. **백엔드 비객체 JSON 배열/문자열 루트 토큰 폭탄 `413` 우회 차단, `/v2/ask` 초장문 `widgetId`/`accessToken`·키 플러딩·미정의 필드 밀수 방어 및 폼 `__proto__` 정화 (`my-server-test/src/app.ts`, `src/endpoints/v2/widget-endpoints.ts`)**
   - **원인**: `src/app.ts` `onParse`가 비객체 JSON 루트(`["A".repeat(4500)]`, `"S".repeat(4500)`)를 일괄 `{}`로 치환하여 `Content-Type: application/json`으로 전송된 `>4,000자` 배열/문자열 토큰 폭탄이 `HTTP 413`을 우회(`403` 또는 `/v2/widget/view`에서 `200 OK`)할 수 있었다. 또한 `/v2/ask`에 `widgetId`/`accessToken` `>4,000자` `413` 가드 및 다수 키 플러딩 가드가 없었고, `/v2/widget/create-thread`와 `/v2/widget/view`에 미정의 추가 필드 밀수(`smuggledHeapBomb`) `413` 가드가 없었으며, `application/x-www-form-urlencoded` 파서에 `__proto__` 필터링이 없었다.
   - **패치**: `/v2/ask`, `/v2/widget/create-thread`, `/v2/widget/view`에서 비-`null` JSON 배열/원시 본문을 보존해 `>4,000`/`>2,000자` 초과 시 정확히 `HTTP 413`을 반환하도록 수정하고, `x-www-form-urlencoded`에서 `__proto__`/`constructor`/`prototype`을 제거했다. 또한 `/v2/ask`에 `widgetId`/`accessToken` `>4,000자` 및 `>32개` 필드 `413` 가드와 미사용 패딩 필드 즉시 힙 해제(`delete body[k]`), `LLM_MAX_TOKENS` `[1, 4096]` 클램핑을 적용하고, `create-thread`/`view`에 `checkUnknownFieldsLimit` `413` 가드를 추가했다.
3. **프런트엔드 호스트 리스너 예외 격리, `0토큰` 빈 말풍선 억제 및 `startVoiceQuestion` 구조화 JSON 오류 파싱 (`tokki-widget/lib/state/chat.tsx`)**
   - **원인**: 호스트 웹페이지가 `chatOps.addEventListener`로 등록한 콜백이 예외를 던지면 활성 SSE 스트림 루프가 즉시 중단되어 정상 답변이 유실되었고 중복 리스너 등록 제한이 없었다. 또한 `[DONE]`만 수신된 `0토큰` 스트림 종료 시 빈 `""` 봇 메시지가 상태 및 `localStorage`에 누적되었으며, `startVoiceQuestion`은 백엔드 `403`/`413`/`503`/`429` JSON 에러 본문을 읽지 않고 일반 네트워크 오류 문구만 반환했다.
   - **패치**: 모든 리스너 호출을 개별 `try/catch`로 격리하고 중복 제거 및 최대 50개 상한을 적용했으며, `0토큰` 스트림 시 빈 봇 메시지 적재를 건너뛰고 `startVoiceQuestion`에서 백엔드 JSON 에러 메시지 및 `Retry-After`를 `startQuestion`과 동일하게 파싱하도록 패치했다.
4. **프런트엔드 프로토타입 테마(`toString`/`constructor`) 차단, 런처 좌표 클램핑, 사용자 평문 `<img` 보존 및 외부 이미지 `no-referrer`·사설 IP 파비콘 SSRF 방어 (`tokki-widget/lib/export.tsx`, `lib/utils/sanitize-css.ts`, `lib/utils/image-parser.ts`, `lib/components/{ChatWindow,ChatWidget,ChatMessage,MarkdownPreview,FunctionCall}.tsx`)**
   - **원인**: `config.theme in chatWidgetTheme` 및 `gradientByTheme[props.theme]`가 `Object.prototype` 속성(`"toString"`, `"constructor"`)에 매칭되어 네이티브 함수 문자열이 DOM `className`에 주입될 수 있었고, `chatBubbleBottomPosition`/`RightPosition`에 `NaN`/음수/초대형 값 검증이 없었다. 또한 `ChatMessage.tsx`가 사용자 평문 메시지에도 `parseImage()`를 적용해 입력 텍스트의 `<img`를 변조했고 코드 블록 내부 `<img`까지 치환했으며, 마크다운/인용 이미지에 `referrerPolicy="no-referrer"`가 없었고 `FunctionCall.tsx`가 `http://` 및 사설/루프백 IP(`127.0.0.1`, `192.168.x`, `10.x`, `169.254.x`)로 파비콘 요청을 발사할 수 있었다.
   - **패치**: `Object.prototype.hasOwnProperty.call`로 테마 검증을 일원화하고 `sanitizeBubbleOffset`(`[0, 500]px`)을 적용했으며, 코드 펜스 보존형 `parseImage()`를 봇 마크다운 메시지에만 적용하도록 수정했다. 아울러 `MarkdownPreview.tsx`와 `FunctionCall.tsx`의 `<img>`에 `referrerPolicy="no-referrer"`·`loading="lazy"`를 강제하고 사설/루프백 호스트 및 비-HTTPS 파비콘 요청을 원천 차단했다.

### 3.2 실시간 `/usr/bin/curl` 적대적 보안 경계 검증 로그 (28개 공격·경계 벡터 전량 통과)

| 벡터 ID | 실측 공격·경계 시나리오 (`/usr/bin/curl`) | 기대 상태 | 실측 상태 | 응답 본문 요약 | 소요 시간 | 판정 |
| :---: | :--- | :---: | :---: | :--- | :---: | :---: |
| `V01` | `POST /v2/ask` — `widgetId` 필드 누락 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `8.83 ms` | **PASS** |
| `V02` | `POST /v2/ask` — 미등록 `widgetId` 변조 (`"evil-spoof-widget-999"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.86 ms` | **PASS** |
| `V03` | `POST /v2/ask` — SQL 인젝션 `widgetId` (`"' OR '1'='1"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `9.01 ms` | **PASS** |
| `V04` | `POST /v2/ask` — 500자 미등록 `widgetId` (DB 무조회 즉시 차단) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.21 ms` | **PASS** |
| `V05` | `POST /v2/ask` — 미등록 `widgetId` + `message` 누락 (`422` 노출 없이 `403`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.82 ms` | **PASS** |
| `V06` | `POST /v2/ask` — CORS Simple Request (`text/plain`) 우회 프로브 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.65 ms` | **PASS** |
| `V07` | `POST /v2/widget/create-thread` — 미등록 `widgetId` 스레드 발급 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id"}` | `5.77 ms` | **PASS** |
| `V08` | `POST /v2/ask` — `x-www-form-urlencoded` `__proto__` 오염 + 미등록 차단 (신규 패치) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.15 ms` | **PASS** |
| `V09` | `POST /v2/ask` — 정상 최대 경계값 `message` 정확히 `4,000자` | `200` | **`200`** | `data: 토키%20 ... data: [DONE]` (정상 SSE 스트리밍) | `63.71 ms` | **PASS** |
| `V10` | `POST /v2/ask` — 경계 초과 `message` `4,001자` | `413` | **`413`** | `{"success":false,"error":"message too long (4001 > 4000 chars)"}` | `7.69 ms` | **PASS** |
| `V11` | `POST /v2/ask` — `50,000자` 한글 토큰 폭탄 (Token Bomb) | `413` | **`413`** | `{"success":false,"error":"message too long (50000 > 4000 chars)"}` | `6.24 ms` | **PASS** |
| `V12` | `POST /v2/ask` — CORS `text/plain` `4,500자` 토큰 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"message too long (4500 > 4000 chars)"}` | `5.65 ms` | **PASS** |
| `V13` | `POST /v2/ask` — JSON Array 루트 `["A"*4500]` 토큰 폭탄 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"message too long (4504 > 4000 chars)"}` | `5.72 ms` | **PASS** |
| `V14` | `POST /v2/ask` — 초장문 `widgetId` `4,500자` 폭탄 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"widgetId too large (4500 > 4000 chars)"}` | `5.12 ms` | **PASS** |
| `V15` | `POST /v2/ask` — 초장문 `accessToken` `4,500자` 및 키 플러딩 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"accessToken too large (4500 > 4000 chars)"}` | `5.65 ms` | **PASS** |
| `V16` | `POST /v2/widget/create-thread` — 미정의 추가 필드(`5,000자`) 밀수 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"extra request fields too large (5016 > 2000 chars)"}` | `5.23 ms` | **PASS** |
| `V17` | `POST /v2/widget/view` — 미정의 추가 필드(`5,000자`) 밀수 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"extra request fields too large (5016 > 2000 chars)"}` | `5.32 ms` | **PASS** |
| `V18` | `POST /v2/widget/create-thread` — 중첩 객체 `widgetId` `4,500자` 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"widgetId too large (4513 > 4000 chars)"}` | `4.89 ms` | **PASS** |
| `V19` | `POST /v2/ask` — 비문자열 `message` 중첩 객체 밀수 (`4,500자`) | `413` | **`413`** | `{"success":false,"error":"message too long (4513 > 4000 chars)"}` | `4.81 ms` | **PASS** |
| `V20` | `POST /v2/ask` — `browserInfo` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"browserInfo too large (2508 > 2000 chars)"}` | `5.25 ms` | **PASS** |
| `V21` | `POST /v2/ask` — `threadId` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2500 > 2000 chars)"}` | `4.47 ms` | **PASS** |
| `V22` | `POST /v2/ask` — `search` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"search options too large (2500 > 2000 chars)"}` | `4.89 ms` | **PASS** |
| `V23` | `POST /v2/widget/view` — `threadId` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2500 > 2000 chars)"}` | `4.74 ms` | **PASS** |
| `V24` | `POST /v2/ask` — `Content-Length > 1MB` (`1.15MB` 바디 선차단) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `4.97 ms` | **PASS** |
| `V25` | `POST /v2/ask` — Chunked + `APPLICATION/JSON ; charset=utf-8` `1.15MB` 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `6.15 ms` | **PASS** |
| `V26` | `POST /v2/admin/widgets/upload-icon` — Chunked `2.35MB` 멀티파트 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 2MB limit"}` | `8.23 ms` | **PASS** |
| `V27` | `POST /v2/admin/widgets/upsert` — 전체화면 클릭재킹 `chat_bubble_size` (`"100vw"`) 차단 | `400` | **`400`** | `{"success":false,"error":"invalid chat_bubble_size (must be a safe CSS size like '48px' or '3.5rem')"}` | `6.24 ms` | **PASS** |
| `V28` | `POST /v2/ask` — 동일 IP 분당 10회 초과 폭주 방어 (11번째 요청) | `429` | **`429`** | `{"success":false,"error":"Too Many Requests",...,"retryAfter":60}` | `4.82 ms` | **PASS** |

---

## 4. R3: 자동화 무결성 검증 및 프리플라이트 빌드 결과

### 4.1 테스트 스위트 실행 결과 (`bun test`)

| 저장소 | 테스트 파일 수 | 통과 / 실패 | `expect()` 단언문 수 | 실행 시간 | 종료 코드 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`my-server-test` (백엔드)** | 13개 파일 | **`332 PASS / 0 FAIL`** | `2,171`개 | `5.87s` | `0` |
| **`tokki-widget` (프런트엔드)** | 2개 파일 | **`42 PASS / 0 FAIL`** | `234`개 | `0.27s` | `0` |
| **합계** | **15개 파일** | **`374 PASS / 0 FAIL` (100%)** | **`2,405`개** | **`6.14s`** | **`0`** |

### 4.2 로컬 프리플라이트 빌드 검증

- **백엔드 번들 동기화 (`my-server-test`)**:
  - `npm run bundle:api` → 7개 SQL 마이그레이션 인라인(`src/generated-migrations.ts`) 및 단일 서버리스 번들 `api/index.js` (`27.0MB`, Node 24 CJS) 빌드 성공 (`112ms`).
  - Node.js CJS 핸들러 스모크 검증 (`require("./api/index.js").default` → `GET /v1/healthz`) → `HTTP 200 OK` 정상 반환 확인.
- **프런트엔드 타입체크 및 프로덕션 번들 빌드 (`tokki-widget`)**:
  - `npm run type-check` (`tsc`) → 타입 오류 `0건`.
  - `npm run build` (라이브러리 빌드 + `.d.ts` 생성) → `dist/` 정상 생성.
  - `npm run build:embed` (임베드 단일 스크립트 빌드) → `dist-embed/tokki.js` 및 `public/embed/tokki.js` 동기화 완료.
  - `npm run export-playground` (플레이그라운드 번들 빌드) → `export-playground/main.js` 정상 생성.

---

## 5. 수락 기준(Acceptance Criteria) 최종 점검표

- [x] **[성능 및 방어 무결성]** 제어된 동시 요청(18건 + 12건) 및 HTTP 429/402 오류 주입 환경에서 교착 상태나 메모리·세마포어 누수(`ZCARD = 0`) 없이 **100% 페일오버**를 달성했는가? → **달성 완료 (`88.26 ms` / `71.34 ms`, 완주율 100%, 파산 형제 키 호출 `0건`, `WARMUP` 카나리 재실패 즉시 백오프 강등 검증 완료, `ZCARD = 0`)**
- [x] **[보안 경계 입증]** 악의적 `widgetId` 변조(`HTTP 403`) 및 초대형 페이로드·토큰 폭탄 공격(`HTTP 413`) 차단이 실측 로그로 입증되었는가? → **28개 실전 `curl` 벡터 전량 통과(`28/28 PASS`) 및 4건의 신규 페일오버·방어선·클라이언트 보안 취약점 즉시 패치 완료**
- [x] **[최종 산출물]** 한국어 감사 보고서(`stress_test_audit.md`)가 생성되었는가? → **양쪽 워크스페이스(`my-server-test`, `tokki-widget`)에 한국어로 생성 완료**
- [x] **[테스트 무결성]** 모든 방어 테스트(`bun test`)가 종료 코드 `0`으로 100% 통과했는가? → **`374 / 374 PASS` (`2,405` assertions, `Exit Code 0`)**
- [x] **[쿼터 보호]** 커밋 메시지에 `[skip ci]`가 포함되어 Vercel 및 GitHub Actions 무료 쿼터를 보호했는가? → **`fix(tokki): automated defense and load test patch [skip ci]` 로컬 커밋 적용 완료 (무료 배포 쿼터 보호를 위해 불필요한 원격 푸시 생략)**
