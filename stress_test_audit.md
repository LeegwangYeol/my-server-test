# 토키 위젯(Tokki Widget) 및 백엔드 서버 일일 부하 테스트 · 적대적 보안 점검 보고서

- **감사 문서 ID**: `AUDIT-TOKKI-DAILY-20261123`
- **세션명**: `[세션명: 토키 위젯 일일 부하 테스트]`
- **문서 버전**: `v7.1.0-DAILY-KO`
- **점검 일시**: 2026년 11월 23일 03:15 KST (`2026-11-23T03:15:00+09:00`)
- **점검 대상**:
  - 백엔드 (`my-server-test`): `/Users/user/src/my-server-test` (`https://my-server-mocha.vercel.app`, Node `v24.22.3` / `iad1` / `commitSha: cb5f128` 활성 확인)
  - 프런트엔드 (`tokki-widget`): `/Users/user/src/tokki-widget`
- **실행 모드**: 단일 에이전트 집중 점검 (`development` 무결성 모드 — 멀티 에이전트 스웜 미사용, 외부 클라우드 유·무료 쿼터 부하 `0`)
- **최종 판정**: **전 항목 통과 (100% PASS — 신규 적발된 동시 인플라이트 리스 `499`/`0` 반납 시 `EXHAUSTED`(`401`/`403`/`402`) 상태 코드 덮어쓰기 결함·`<4,000자` 중복 JSON 보조/추가 키 및 폼 쌍 플러딩 `413` 우회·모바일 `onTouchStart` 내 `useEffect` 호출 크래시 및 `100K` 스트림 상한/`setThreadId` 오염·사설 LAN/NAT64 호스트 및 복합 쿼리 시크릿 유출 취약점 4건 즉시 패치 및 영구 회귀 테스트 반영 완료)**

---

## 1. 핵심 요약 (Executive Summary)

본 일일 정기 점검은 제3자 무료 클라우드 서비스(Vercel Serverless Fluid Active CPU·일일 배포 횟수, Supabase DB, Upstash Redis, OpenRouter 크레딧)의 쿼터 소모를 원천 차단하기 위해 로컬 허메틱(Hermetic) 실전 HTTP 서버(`Bun.serve` + `createApp(true)` 전 계층 무모킹 실구동)와 실제 `/usr/bin/curl` 프로세스를 사용하여 수행되었다(라이브 프로덕션 `my-server-mocha.vercel.app`에는 무부하 단일 헬스체크 GET 2회만 수행).

1. **[R1] 제어된 경량 동시성 제어 및 HTTP 429/402 페일오버 방어 검증 (`api_key_rotation_plan.md` ZSET 세마포어 준수)**:
   - 5개 API 키·4개 계정 풀(`acc-bankrupt` 파산 계정 2개 형제 키 [Mock `402`], `acc-ratelim-1` 속도 제한 [Mock `429 Retry-After: 15`], `acc-ratelim-2` 속도 제한 [Mock `429 Retry-After: HTTP-date +18s`], `acc-healthy` 정상 계정 [Mock `200` 멀티청크 SSE])을 대상으로 **1차 콜드 페일오버 버스트 동시 18건(정상 SSE 완주 16건 + 스트리밍 도중 클라이언트 강제 연결 종료 2건)** 및 **2차 웜 스테디스테이트 동시 12건**을 실행했다.
   - **1차 콜드 페일오버 버스트(18건)** 총 소요 시간 **`85.91 ms`**(`Min: 74.69 ms`, `p50: 77.21 ms`, `p95/Max: 83.65 ms`), **2차 웜 스테디스테이트(12건)** 총 소요 시간 **`73.55 ms`**(`Min: 70.66 ms`, `p50: 71.66 ms`, `p95/Max: 73.19 ms`)로 서버리스 타임아웃(`60,000 ms`)의 **0.15% 이내**에 교착 상태(Deadlock) 없이 **100% 페일오버 완주**를 달성했다.
   - `k1-dead-a`에서 최초 `HTTP 402`가 감지된 즉시 동일 계정(`acc-bankrupt`) 소속 형제 키 `k2-dead-b`는 **업스트림 호출 `0건`**으로 즉시 파산(`EXHAUSTED`) 격리되었으며, 2차 웨이브 12건에서는 파산·쿨다운 상태의 불량 키(1~4번 키) 호출이 **`0건`**으로 완벽히 차단되었다. 모든 스트림 완주 및 강제 중단(`499`) 직후 전 키의 ZSET 활성 리스 수(`inFlightRequests`)는 **`ZCARD = 0`**으로 전량 회수되어 세마포어·메모리 누수가 없음을 입증했다.
2. **[R2] 프런트엔드-백엔드 적대적 보안 감사 및 즉시 패치 (4건 신규 보강)**:
   - 미등록/누락/SQLi/500자/`message` 누락/CORS `text/plain`/`x-www-form-urlencoded` `__proto__` 오염/중복 JSON `widgetId` 스머글링/중복 폼 `widgetId` HPP 변조 요청이 `/v2/ask` 및 `/v2/widget/create-thread`에서 **100% `HTTP 403 Forbidden`**으로 차단되고, `4,000자` 초과 메시지·중복 JSON `message`/`browserInfo`/`\u0073earch`/미정의 필드 덮어쓰기 폭탄·중복 폼 파라미터 쌍 플러딩·비업로드 `multipart/form-data` 폭탄·공백 패딩 JSON `null` 폭탄·JSON 배열 루트 폭탄·초장문 `widgetId`/`accessToken`·보조 필드(`browserInfo`, `threadId`, `search`)·`1MB`(업로드 `2MB`) 초과 스트리밍 본문이 **100% `HTTP 413 Payload Too Large`**로 차단됨을 **36개 실전 `/usr/bin/curl` 벡터 전량 통과(`36/36 PASS`)**로 입증했다.
   - 심층 코드 감사에서 적발된 **4건의 신규 취약점 및 페일오버 결함**(① 동시 인플라이트 리스가 클라이언트 중단(`499`) 또는 프로바이더 장애(`0`)로 반납될 때 이미 `EXHAUSTED`(`401`/`403` 영구 폐기 또는 `402` 지갑 고갈) 상태인 키의 `lastStatusCode`/`last_error_code`를 덮어써 지갑 충전 복구 시 폐기된 `401` 키가 부활하거나 `402` 형제 키가 복구 누락되던 상태 머신 결함 + `DEFAULT_KEY_MAX_CONCURRENCY` Upstash/Memory 전파 및 스트리밍 중 `429` 동적 백오프 연동, ② `<4,000자` 바디에서 중복 JSON 보조/미정의 키(`browserInfo`, `\u0073earch`, `junk`) 덮어쓰기로 `>2,000자` `413` 가드를 우회하던 결함 및 중복 루트 프로퍼티·폼 파라미터 쌍 플러딩 차단, ③ `ChatWindow.tsx`의 `onTouchStart` 이벤트 핸들러 내부 `useEffect` 호출(`safariTouch`)로 인한 모바일 터치 즉시 React 런타임 크래시·무제한 스트림 버퍼(`100,000자` 상한 적용)·`setThreadId`/`setWidgetId`/`mount`의 `>100자` 오염 `threadId` `413` Self-DoS 방지, ④ `getBrowserInfo`/`FunctionCall`의 사설 RFC1918 LAN·NAT64(`64:ff9b::/96`)·`.internal`/`.corp` 인트라넷 호스트 노출 및 복합 쿼리 파라미터(`openrouter_api_key`, `csrf_token`, `oobCode` 등) 시크릿 마스킹 강화)을 **즉시 전량 패치**했다.
3. **[R3] 자동화 무결성 검증 및 프리플라이트 빌드·쿼터 보호**:
   - 백엔드 `bun test` **339 / 339 PASS** (`2,242` assertions) + 프런트엔드 `bun test` **44 / 44 PASS** (`270` assertions) = **총 383 / 383 테스트 100% 통과 (`2,512` expect 단언문, 종료 코드 `0`)**.
   - 사전 빌드(`npm run bundle:api` → `api/index.js` `27.0MB`, `npm run type-check`, `npm run build`, `npm run build:embed`, `npm run export-playground`) 전량 무오류 통과 및 `[skip ci]` 로컬 커밋 규칙을 준수했다.

---

## 2. R1: 경량 동시성 제어 및 429/402 페일오버 방어 실측 결과

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
| **총 동시 실행 Wall-Clock 시간** | **`85.91 ms`** | **`73.55 ms`** | `< 60,000 ms` (서버리스 타임아웃) | **PASS** |
| **정상 SSE 완주 성공률** | **`16 / 16 (100%)`** | **`12 / 12 (100%)`** | `100%` (`data: [DONE]` 확인) | **PASS** |
| **지연시간 분포 (`Min / p50 / p95 / Max`)** | `74.69 / 77.21 / 83.65 / 83.65 ms` | `70.66 / 71.66 / 73.19 / 73.19 ms` | 무교착 · 일관된 응답성 | **PASS** |
| **스트리밍 중 클라이언트 강제 중단 (`499`)** | `2 / 2` 즉시 `cancel()` 및 리스 반납 | — | 좀비 세마포어 리스 `0건` | **PASS** |
| **형제 파산 키(`k2-dead-b`) 낭비 호출** | **`0 건`** (`acc-bankrupt` 계정 단위 즉시 차단) | **`0 건`** | 계정 단위 Fast-Break 작동 | **PASS** |
| **동시 인플라이트 `499`/`0` 반납 시 `401`/`402` 보존** | `resetKeyToActive` 후 `402` 형제 키 모두 복구, `401` 폐기 키 영구 격리 유지 | — | 폐기 키 부활·복구 누락 `0건` | **PASS** |
| **종료 후 ZSET 활성 리스 합계 (`ZCARD`)** | **`0`** | **`0`** | 정확히 `0` (Zero Leak) | **PASS** |
| **미등록 요청 시 고아 스레드 생성 수** | **`0 건`** | **`0 건`** | DB 오염 `0건` | **PASS** |

> **프로덕션 라이브 헬스체크 (무부하 단일 GET 2회)**:
> - `GET https://my-server-mocha.vercel.app/v1/healthz` → `HTTP 200` (`"OK"`, 콜드 응답 `1,875.67 ms`)
> - `GET https://my-server-mocha.vercel.app/v1/heartbeat` → `HTTP 200` (`{"status":"alive","node":"v24.22.3","region":"iad1","commitSha":"cb5f128"}`, 웜 응답 `229.62 ms`)

---

## 3. R2: 적대적 보안 감사 결과 및 즉시 패치 내역

### 3.1 금일(2026-11-23) 적발 즉시 패치한 페일오버·방어선·프런트엔드 보안 취약점 (4건)

1. **[중대] 동시 인플라이트 리스 `499`/`0` 반납 시 `EXHAUSTED`(`401`/`403`/`402`) 상태 코드 덮어쓰기 차단 및 동시성 한도·인밴드 `429` 동기화 (`my-server-test/lib/llm/key-manager/stores/{memory,upstash-redis}.ts`, `lib/llm/key-manager/lua/scripts.ts`, `lib/llm/{factory,rotating-provider}.ts`)**
   - **원인**: 하나의 키에 복수의 동시 요청(`leaseA`, `leaseB`)이 진입한 상태에서 `leaseA`가 `401`(폐기된 키) 또는 `402`(지갑 고갈)로 `EXHAUSTED` 전환된 직후, 이미 실행 중이던 `leaseB`가 클라이언트 연결 종료(`499`) 또는 업스트림 모델 장애/클라이언트 오류(`statusCode = 0, cooldown = 0`)로 반납되면 `MemoryKeyStore.releaseKey`와 `RELEASE_KEY_LUA`가 `EXHAUSTED` 여부를 확인하지 않고 `lastStatusCode`(`last_error_code`)를 `499` 또는 `0`으로 덮어썼다. 이로 인해 `401` 폐기 키가 이후 형제 키 `402` + `resetKeyToActive` 시 `ACTIVE`로 되살아나거나, 반대로 `402` 형제 키가 `499`로 기록되어 지갑 충전 후에도 영구 복구 누락되는 결함이 발생했다. 또한 `UpstashRedisKeyStore`가 `RESERVE_KEY_LUA`에 `DEFAULT_KEY_MAX_CONCURRENCY` 대신 고정값 `5`를 전달했고 스트리밍 중 인밴드 SSE `429` 발생 시 누적 `consecutive429s`가 백오프 계산에 반영되지 않았다.
   - **패치**: `statusCode === 0 && cooldown === 0` 및 `statusCode === 499` 반납 경로에서 `EXHAUSTED`/`DISABLED` 키의 `lastStatusCode`·`lastErrorMessage` 덮어쓰기를 원천 차단하고 `WARMUP` 카나리아 토큰 정리(`canaryToken = undefined` / `HDEL`)를 추가했다. 아울러 `getKeyStore()` 및 `UpstashRedisKeyStore`에 `defaultMaxConcurrency`를 일관 전달하고 인밴드 SSE `429` 시 실시간 `consecutive429s`를 읽어 지수 백오프가 단계적으로 상승하도록 보강했다.
2. **백엔드 `<4,000자` 중복 JSON 보조·추가 키 덮어쓰기(`413`) 및 중복 프로퍼티·폼 파라미터 쌍 플러딩 차단 (`my-server-test/src/app.ts`)**
   - **원인**: 기존 `scanDuplicateRootJsonKeys`는 전체 길이가 `4,000자`를 넘을 때만 즉시 차단하고 `4,000자` 이하일 때는 `widgetId`·`message`·`threadId` 3개 키만 마킹했다. 그 결과 공격자가 `{"widgetId":"valid","message":"hi","browserInfo":"B"*2500,"browserInfo":"ok"}`(총 ~2,560자 `< 4,000자`), 유니코드 이스케이프 `\u0073earch` 중복, 또는 `/v2/widget/create-thread`에 `{"widgetId":"valid","junk":"J"*2500,"junk":"1"}`을 전송하면 `JSON.parse()`가 앞의 `2,500자` 페이로드를 뒤의 짧은 값으로 덮어써 보조/미정의 필드의 `>2,000자` `HTTP 413` 가드를 우회할 수 있었다. 또한 동일 키를 35회 이상 반복(`"dup":1,...` 또는 `dup=1&dup=1...`)하면 `Object.keys` 개수가 축소되어 필드 개수 상한을 우회했다.
   - **패치**: 단일 패스 RFC 8259 루트 객체 검사기(`inspectRootJsonObject`)로 교체하여 원시 루트 프로퍼티 총개수(`>32` / `>12`) 초과 시 즉시 `HTTP 413`으로 차단하고, 모든 중복 루트 키의 전체 값 배열(`[v1, v2, ...]`)을 보존하여 `browserInfo`·`search`·`junk` 등 모든 필드의 중복 덮어쓰기 폭탄을 빠짐없이 `HTTP 413`으로 격리했다. 동시에 `x-www-form-urlencoded` 원시 파라미터 쌍 개수 상한(`>32` / `>12`) 및 빈 `text/plain` 바디 정규화를 적용했다.
3. **프런트엔드 모바일 `onTouchStart` React Hook 크래시 제거, `100,000자` 스트림 버퍼 상한 및 `setThreadId`/`mount` 오염 정화 (`tokki-widget/lib/components/ChatWindow.tsx`, `lib/state/chat.tsx`, `lib/export.tsx`)**
   - **원인**: `ChatWindow.tsx`의 `<textarea onTouchStart={safariTouch}>` 핸들러가 이벤트 콜백 내부에서 `useEffect(...)`를 호출(`eslint-disable react-hooks/rules-of-hooks`로 은폐됨)하고 있어 모바일 환경에서 입력창 터치 즉시 React `"Invalid hook call"` 런타임 크래시와 `document` `touchstart` 리스너 누수를 유발했다. 또한 스트리밍 버퍼(`shiftedResponseText + streamResponseText`)에 상한이 없었고, `data-thread-id`나 `MountConfig.threadId` 또는 `chatOps.setThreadId()`로 `>100자`/제어문자 `threadId`가 주입되면 이후 모든 `/v2/ask` 호출이 영구 `HTTP 413` Self-DoS에 빠졌다.
   - **패치**: `safariTouch` 훅 위반 코드를 순수 이벤트 핸들러(`handleTextareaTouchStart`)로 교체하여 모바일 크래시와 리스너 누수를 제거하고, 스트림 누적 버퍼를 백엔드와 동일한 `100,000자`로 제한했으며, `setThreadId`·`setWidgetId`·`attach`·`configFromDataset` 전 경로에 `<=100자` 및 제어문자 정화를 적용했다.
4. **프런트엔드 사설 LAN·NAT64·인트라넷 호스트 유출 차단 및 복합 쿼리 시크릿 마스킹 확대 (`tokki-widget/lib/utils/get-browser-info.ts`, `lib/components/{FunctionCall,ChatWidget}.tsx`)**
   - **원인**: `getBrowserInfo()`가 루프백(`127.x`, `localhost`)만 제외하고 사설 RFC1918 대역(`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), 링크로컬(`169.254.0.0/16`, `fe80::`), CGNAT(`100.64.0.0/10`), ULA(`fc00::/7`), NAT64(`64:ff9b::/96`), 사내 도메인(`.internal`, `.corp`, `.lan`)을 외부 서버로 전송할 수 있었고, 쿼리 파라미터 마스킹이 정확히 일치하는 키만 검사해 `openrouter_api_key`, `csrf_token`, `oobCode` 같은 복합 시크릿 키가 평문 노출되었다.
   - **패치**: `getBrowserInfo()`와 `FunctionCall` SSRF 가드에 사설 RFC1918·CGNAT·링크로컬·ULA·NAT64·인트라넷 도메인 차단을 통합하고 파싱 실패 URL 폴백 노출을 제거했으며, 부분 문자열 패턴(`token`, `secret`, `passw`, `api_key`, `oobcode`, `credential` 등)까지 `[REDACTED]` 처리하고 `ChatWidget`의 헤드리스/SSR `window`/`screen`/`navigator` 안전 가드를 추가했다.

### 3.2 실시간 `/usr/bin/curl` 적대적 보안 경계 검증 로그 (36개 공격·경계 벡터 전량 통과)

| 벡터 ID | 실측 공격·경계 시나리오 (`/usr/bin/curl`) | 기대 상태 | 실측 상태 | 응답 본문 요약 | 소요 시간 | 판정 |
| :---: | :--- | :---: | :---: | :--- | :---: | :---: |
| `V01` | `POST /v2/ask` — `widgetId` 필드 누락 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `8.63 ms` | **PASS** |
| `V02` | `POST /v2/ask` — 미등록 `widgetId` 변조 (`"evil-spoof-widget-999"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `7.16 ms` | **PASS** |
| `V03` | `POST /v2/ask` — SQL 인젝션 `widgetId` (`"' OR '1'='1"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.16 ms` | **PASS** |
| `V04` | `POST /v2/ask` — 500자 미등록 `widgetId` (DB 무조회 즉시 차단) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.18 ms` | **PASS** |
| `V05` | `POST /v2/ask` — 미등록 `widgetId` + `message` 누락 (`422` 노출 없이 `403`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.05 ms` | **PASS** |
| `V06` | `POST /v2/ask` — CORS Simple Request (`text/plain`) 우회 프로브 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.49 ms` | **PASS** |
| `V07` | `POST /v2/widget/create-thread` — 미등록 `widgetId` 스레드 발급 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id"}` | `5.76 ms` | **PASS** |
| `V08` | `POST /v2/ask` — `x-www-form-urlencoded` `__proto__` 오염 + 미등록 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.33 ms` | **PASS** |
| `V09` | `POST /v2/ask` — JSON 중복 `widgetId` 키 스머글링 차단 (`{"widgetId":"evil","widgetId":"valid"}`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.13 ms` | **PASS** |
| `V10` | `POST /v2/ask` — `x-www-form-urlencoded` 중복 `widgetId` HPP 스머글링 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.04 ms` | **PASS** |
| `V11` | `POST /v2/ask` — 정상 최대 경계값 `message` 정확히 `4,000자` | `200` | **`200`** | `data: 토키%20 ... data: [DONE]` (정상 SSE 스트리밍) | `63.29 ms` | **PASS** |
| `V12` | `POST /v2/ask` — 경계 초과 `message` `4,001자` | `413` | **`413`** | `{"success":false,"error":"message too long (4001 > 4000 chars)"}` | `7.22 ms` | **PASS** |
| `V13` | `POST /v2/ask` — `50,000자` 한글 토큰 폭탄 (Token Bomb) | `413` | **`413`** | `{"success":false,"error":"message too long (50000 > 4000 chars)"}` | `6.32 ms` | **PASS** |
| `V14` | `POST /v2/ask` — JSON 중복 `message` 덮어쓰기 토큰 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `6.31 ms` | **PASS** |
| `V15` | `POST /v2/ask` — `x-www-form-urlencoded` 중복 `message` HPP 토큰 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"message too long (4509 > 4000 chars)"}` | `5.66 ms` | **PASS** |
| `V16` | `POST /v2/ask` — 비업로드 `multipart/form-data` `4,500자` 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"message too long (4500 > 4000 chars)"}` | `5.22 ms` | **PASS** |
| `V17` | `POST /v2/widget/view` — 공백 패딩 JSON `null` (`2,504자`) 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"request body too large (2504 > 2000 chars)"}` | `5.65 ms` | **PASS** |
| `V18` | `POST /v2/ask` — CORS `text/plain` `4,500자` 토큰 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"message too long (4500 > 4000 chars)"}` | `5.31 ms` | **PASS** |
| `V19` | `POST /v2/ask` — JSON Array 루트 `["A"*4500]` 토큰 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"message too long (4504 > 4000 chars)"}` | `5.14 ms` | **PASS** |
| `V20` | `POST /v2/ask` — 초장문 `widgetId` `4,500자` 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"widgetId too large (4500 > 4000 chars)"}` | `4.96 ms` | **PASS** |
| `V21` | `POST /v2/ask` — 초장문 `accessToken` `4,500자` 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"accessToken too large (4500 > 4000 chars)"}` | `5.17 ms` | **PASS** |
| `V22` | `POST /v2/widget/create-thread` — 미정의 추가 필드(`5,000자`) 밀수 차단 | `413` | **`413`** | `{"success":false,"error":"extra request fields too large (5005 > 2000 chars)"}` | `5.04 ms` | **PASS** |
| `V23` | `POST /v2/widget/view` — 미정의 추가 필드(`5,000자`) 밀수 차단 | `413` | **`413`** | `{"success":false,"error":"extra request fields too large (5005 > 2000 chars)"}` | `4.74 ms` | **PASS** |
| `V24` | `POST /v2/ask` — 비문자열 `message` 중첩 객체 밀수 (`4,500자`) | `413` | **`413`** | `{"success":false,"error":"message too long (4513 > 4000 chars)"}` | `4.85 ms` | **PASS** |
| `V25` | `POST /v2/ask` — `browserInfo` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"browserInfo too large (2510 > 2000 chars)"}` | `4.75 ms` | **PASS** |
| `V26` | `POST /v2/ask` — `threadId` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2500 > 2000 chars)"}` | `4.43 ms` | **PASS** |
| `V27` | `POST /v2/ask` — `search` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"search options too large (2500 > 2000 chars)"}` | `4.74 ms` | **PASS** |
| `V28` | `POST /v2/ask` — JSON 중복 `browserInfo` (`<4,000자`) 덮어쓰기 스머글링 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"browserInfo too large (2509 > 2000 chars)"}` | `4.65 ms` | **PASS** |
| `V29` | `POST /v2/ask` — 유니코드 이스케이프 중복 `\u0073earch` (`<4,000자`) 덮어쓰기 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"search options too large (2509 > 2000 chars)"}` | `4.77 ms` | **PASS** |
| `V30` | `POST /v2/widget/create-thread` — JSON 중복 미정의 필드 (`<4,000자`) 덮어쓰기 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"extra request fields too large (2512 > 2000 chars)"}` | `4.64 ms` | **PASS** |
| `V31` | `POST /v2/ask` — `x-www-form-urlencoded` 중복 파라미터 플러딩 (`35개 쌍`) 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.00 ms` | **PASS** |
| `V32` | `POST /v2/ask` — `Content-Length > 1MB` (`1.15MB` 바디 선차단) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `4.93 ms` | **PASS** |
| `V33` | `POST /v2/ask` — Chunked + `APPLICATION/JSON ; charset=utf-8` `1.15MB` 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.19 ms` | **PASS** |
| `V34` | `POST /v2/admin/widgets/upload-icon` — Chunked `2.35MB` 멀티파트 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 2MB limit"}` | `7.34 ms` | **PASS** |
| `V35` | `POST /v2/admin/widgets/upsert` — 전체화면 클릭재킹 `chat_bubble_size` (`"100vw"`) 차단 | `400` | **`400`** | `{"success":false,"error":"invalid chat_bubble_size (must be a safe CSS size like '48px' or '3.5rem')"}` | `6.52 ms` | **PASS** |
| `V36` | `POST /v2/ask` — 동일 IP 분당 10회 초과 폭주 방어 (11번째 요청) | `429` | **`429`** | `{"success":false,"error":"Too Many Requests",...,"retryAfter":60}` | `4.54 ms` | **PASS** |

---

## 4. R3: 자동화 무결성 검증 및 프리플라이트 빌드 결과

### 4.1 테스트 스위트 실행 결과 (`bun test`)

| 저장소 | 테스트 파일 수 | 통과 / 실패 | `expect()` 단언문 수 | 실행 시간 | 종료 코드 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`my-server-test` (백엔드)** | 13개 파일 | **`339 PASS / 0 FAIL`** | `2,242`개 | `6.41s` | `0` |
| **`tokki-widget` (프런트엔드)** | 2개 파일 | **`44 PASS / 0 FAIL`** | `270`개 | `0.24s` | `0` |
| **합계** | **15개 파일** | **`383 PASS / 0 FAIL` (100%)** | **`2,512`개** | **`6.65s`** | **`0`** |

### 4.2 로컬 프리플라이트 빌드 검증

- **백엔드 번들 동기화 (`my-server-test`)**:
  - `npm run bundle:api` → 7개 SQL 마이그레이션 인라인(`src/generated-migrations.ts`) 및 단일 서버리스 번들 `api/index.js` (`27.0MB`, Node 24 CJS) 빌드 성공.
  - Node.js CJS 핸들러 스모크 검증 (`require("./api/index.js").default` → `GET /v1/healthz`) → `HTTP 200 OK` 정상 반환 확인.
- **프런트엔드 타입체크 및 프로덕션 번들 빌드 (`tokki-widget`)**:
  - `npm run type-check` (`tsc`) → 타입 오류 `0건`.
  - `npm run build` (라이브러리 빌드 + `.d.ts` 생성) → `dist/` 정상 생성.
  - `npm run build:embed` (임베드 단일 스크립트 빌드) → `dist-embed/tokki.js` 및 `public/embed/tokki.js` 동기화 완료.
  - `npm run export-playground` (플레이그라운드 번들 빌드) → `export-playground/main.js` 정상 생성.

---

## 5. 수락 기준(Acceptance Criteria) 최종 점검표

- [x] **[성능 및 방어 무결성]** 제어된 동시 요청(18건 + 12건) 및 HTTP 429/402 오류 주입 환경에서 교착 상태나 메모리·세마포어 누수(`ZCARD = 0`) 없이 **100% 페일오버**를 달성했는가? → **달성 완료 (`85.91 ms` / `73.55 ms`, 완주율 100%, 파산 형제 키 호출 `0건`, 동시 인플라이트 `499`/`0` 반납 시 `401`/`402` 상태 보존 검증 완료, `ZCARD = 0`)**
- [x] **[보안 경계 입증]** 악의적 `widgetId` 변조(`HTTP 403`) 및 초대형 페이로드·토큰 폭탄 공격(`HTTP 413`) 차단이 실측 로그로 입증되었는가? → **36개 실전 `curl` 벡터 전량 통과(`36/36 PASS`) 및 4건의 신규 페일오버·방어선·모바일 크래시·클라이언트 보안 취약점 즉시 패치 완료**
- [x] **[최종 산출물]** 한국어 감사 보고서(`stress_test_audit.md`)가 생성되었는가? → **양쪽 워크스페이스(`my-server-test`, `tokki-widget`)에 한국어로 생성 완료**
- [x] **[테스트 무결성]** 모든 방어 테스트(`bun test`)가 종료 코드 `0`으로 100% 통과했는가? → **`383 / 383 PASS` (`2,512` assertions, `Exit Code 0`)**
- [x] **[쿼터 보호]** 커밋 메시지에 `[skip ci]`가 포함되어 Vercel 및 GitHub Actions 무료 쿼터를 보호했는가? → **`fix(tokki): automated defense and load test patch [skip ci]` 로컬 커밋 적용 완료 (무료 배포 쿼터 보호를 위해 불필요한 원격 푸시 생략)**
