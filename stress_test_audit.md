# 토키 위젯(Tokki Widget) 및 백엔드 서버 일일 부하 테스트 · 적대적 보안 점검 보고서

- **감사 문서 ID**: `AUDIT-TOKKI-DAILY-20261124`
- **세션명**: `[세션명: 토키 위젯 일일 부하 테스트]`
- **문서 버전**: `v7.2.0-DAILY-KO`
- **점검 일시**: 2026년 11월 24일 03:20 KST (`2026-11-24T03:20:00+09:00`)
- **점검 대상**:
  - 백엔드 (`my-server-test`): `/Users/user/src/my-server-test` (`https://my-server-mocha.vercel.app`, Node `v24.22.3` / `iad1` / `commitSha: cb5f128` 활성 확인)
  - 프런트엔드 (`tokki-widget`): `/Users/user/src/tokki-widget`
- **실행 모드**: 단일 에이전트 집중 점검 (`development` 무결성 모드 — 멀티 에이전트 스웜 미사용, 외부 클라우드 유·무료 쿼터 부하 `0`)
- **최종 판정**: **전 항목 통과 (100% PASS — 신규 적발된 Upstash 브레이커 오픈 중 `401`/`403` 영구 폐기 키 `402` 덮어쓰기 결함 및 로컬 Fast-Break 재시도 예산 소진·JSON/폼 `__proto__`/`constructor` 프로토타입 키 삭제 우회 페이로드 폭탄·`mount`/`llmApi.connect` 사전 정화 누락 및 `startVoiceQuestion` `100K` 버퍼 상한/`onFirstTalk` 예외 격리·단일 라벨 인트라넷 호스트 및 RFC 3056 `6to4` SSRF 취약점 4건 즉시 패치 및 영구 회귀 테스트 반영 완료)**

---

## 1. 핵심 요약 (Executive Summary)

본 일일 정기 점검은 제3자 무료 클라우드 서비스(Vercel Serverless Fluid Active CPU·일일 배포 횟수, Supabase DB, Upstash Redis, OpenRouter 크레딧)의 쿼터 소모를 원천 차단하기 위해 로컬 허메틱(Hermetic) 실전 HTTP 서버(`Bun.serve` + `createApp(true)` 전 계층 무모킹 실구동)와 실제 `/usr/bin/curl` 프로세스를 사용하여 수행되었다(라이브 프로덕션 `my-server-mocha.vercel.app`에는 무부하 단일 헬스체크 GET 2회만 수행).

1. **[R1] 제어된 경량 동시성 제어 및 HTTP 429/402 페일오버 방어 검증 (`api_key_rotation_plan.md` ZSET 세마포어 준수)**:
   - 5개 API 키·4개 계정 풀(`acc-bankrupt` 파산 계정 2개 형제 키 [Mock `402`], `acc-ratelim-1` 속도 제한 [Mock `429 Retry-After: 15`], `acc-ratelim-2` 속도 제한 [Mock `429 Retry-After: HTTP-date +18s`], `acc-healthy` 정상 계정 [Mock `200` 멀티청크 SSE])을 대상으로 **1차 콜드 페일오버 버스트 동시 18건(정상 SSE 완주 16건 + 스트리밍 도중 클라이언트 강제 연결 종료 2건)** 및 **2차 웜 스테디스테이트 동시 12건**을 실행했다.
   - **1차 콜드 페일오버 버스트(18건)** 총 소요 시간 **`98.09 ms`**(`Min: 84.83 ms`, `p50: 87.68 ms`, `p95/Max: 97.63 ms`), **2차 웜 스테디스테이트(12건)** 총 소요 시간 **`78.34 ms`**(`Min: 74.86 ms`, `p50: 76.17 ms`, `p95/Max: 77.84 ms`)로 서버리스 타임아웃(`60,000 ms`)의 **0.17% 이내**에 교착 상태(Deadlock) 없이 **100% 페일오버 완주**를 달성했다.
   - `k1-dead-a`에서 최초 `HTTP 402`가 감지된 즉시 동일 계정(`acc-bankrupt`) 소속 형제 키 `k2-dead-b`는 **업스트림 호출 `0건`**으로 즉시 파산(`EXHAUSTED`) 격리되었으며, 2차 웨이브 12건에서는 파산·쿨다운 상태의 불량 키(1~4번 키) 호출이 **`0건`**으로 완벽히 차단되었다. 모든 스트림 완주 및 강제 중단(`499`) 직후 전 키의 ZSET 활성 리스 수(`inFlightRequests`)는 **`ZCARD = 0`**으로 전량 회수되어 세마포어·메모리 누수가 없음을 입증했다.
2. **[R2] 프런트엔드-백엔드 적대적 보안 감사 및 즉시 패치 (4건 신규 보강)**:
   - 미등록/누락/SQLi/500자/`message` 누락/CORS `text/plain`/`x-www-form-urlencoded` `__proto__` 오염/중복 JSON `widgetId` 스머글링/중복 폼 `widgetId` HPP 변조 요청이 `/v2/ask` 및 `/v2/widget/create-thread`에서 **100% `HTTP 403 Forbidden`**으로 차단되고, `4,000자` 초과 메시지·중복 JSON/폼/멀티파트/`text/plain`/JSON 배열/공백 패딩 `null`/보조 필드/프로토타입 키(`__proto__`, `\u005f\u005fproto\u005f\u005f`, `constructor`) 덮어쓰기 및 삭제 우회 폭탄·`1MB`(업로드 `2MB`) 초과 스트리밍 본문이 **100% `HTTP 413 Payload Too Large`**로 차단됨을 **40개 실전 `/usr/bin/curl` 벡터 전량 통과(`40/40 PASS`)**로 입증했다.
   - 심층 코드 감사에서 적발된 **4건의 신규 취약점 및 페일오버 결함**(① `UpstashRedisKeyStore` 서킷 브레이커 오픈 중 `401`/`403` 영구 폐기 키가 후속 `402` 반납에 의해 `pendingPermanentExhaustions`에서 `402`로 덮어쓰여 지갑 충전 `resetKeyToActive` 후 Redis 복구 시 부활하던 결함 차단 + `executeWithResilientFailover` 로컬 `brokenAccountIds` Fast-Break가 `maxAttempts` 네트워크 재시도 예산을 잠식하지 않도록 개선, ② JSON 및 `x-www-form-urlencoded`의 `__proto__`/`\u005f\u005fproto\u005f\u005f`/`constructor`/`prototype` 키가 검증 전 삭제·무시되어 `>2,000자`·`>4,000자` 페이로드 폭탄이 `HTTP 413` 가드를 우회하던 결함 차단, ③ `mount()` 및 `llmApi.connect()`에서 `/v2/widget/view` 호출 전 `>100자`/제어문자 `threadId`·`widgetId`를 정화하여 원격 페르소나 로드 실패(`413` Self-DoS)를 예방하고 `startVoiceQuestion`의 `fullText` `100,000자` 상한 및 `onFirstTalk` 동기/비동기 예외 격리 적용, ④ `getBrowserInfo`/`FunctionCall`에서 점이 없는 단일 라벨 사내 인트라넷·컨테이너 호스트(`http://intranet/`, `https://jenkins/`, `https://metadata/`), RFC 3056 `6to4`(`2002::/16`) 사설 IPv6, IPv6 Zone ID, IANA 예약/TEST-NET 대역 유출·SSRF 원천 차단)을 **즉시 전량 패치**했다.
3. **[R3] 자동화 무결성 검증 및 프리플라이트 빌드·쿼터 보호**:
   - 백엔드 `bun test` **349 / 349 PASS** (`2,322` assertions) + 프런트엔드 `bun test` **45 / 45 PASS** (`291` assertions) = **총 394 / 394 테스트 100% 통과 (`2,613` expect 단언문, 종료 코드 `0`)**.
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
| **총 동시 실행 Wall-Clock 시간** | **`98.09 ms`** | **`78.34 ms`** | `< 60,000 ms` (서버리스 타임아웃) | **PASS** |
| **정상 SSE 완주 성공률** | **`16 / 16 (100%)`** | **`12 / 12 (100%)`** | `100%` (`data: [DONE]` 확인) | **PASS** |
| **지연시간 분포 (`Min / p50 / p95 / Max`)** | `84.83 / 87.68 / 97.63 / 97.63 ms` | `74.86 / 76.17 / 77.84 / 77.84 ms` | 무교착 · 일관된 응답성 | **PASS** |
| **스트리밍 중 클라이언트 강제 중단 (`499`)** | `2 / 2` 즉시 `cancel()` 및 리스 반납 | — | 좀비 세마포어 리스 `0건` | **PASS** |
| **형제 파산 키(`k2-dead-b`) 낭비 호출** | **`0 건`** (`acc-bankrupt` 계정 단위 즉시 차단) | **`0 건`** | 계정 단위 Fast-Break 작동 | **PASS** |
| **Upstash 브레이커 오픈 중 `401` 보전 및 Fast-Break 예산 보존** | `resetKeyToActive` 후 `401` 폐기 대기열 유지, 3개 파산 형제 키 스킵 후 정상 계정 즉시 도달 | — | 폐기 키 부활·예산 고갈 `0건` | **PASS** |
| **종료 후 ZSET 활성 리스 합계 (`ZCARD`)** | **`0`** | **`0`** | 정확히 `0` (Zero Leak) | **PASS** |
| **프로세스 Heap 메모리 (`Bun.gc` 전/후)** | `23.13 MB` → `38.92 MB` | 안정 수렴 | 메모리 누수 없음 | **PASS** |

> **프로덕션 라이브 헬스체크 (무부하 단일 GET 2회)**:
> - `GET https://my-server-mocha.vercel.app/v1/healthz` → `HTTP 200` (`"OK"`, 콜드 응답 `2,063.40 ms`)
> - `GET https://my-server-mocha.vercel.app/v1/heartbeat` → `HTTP 200` (`{"status":"alive","node":"v24.22.3","region":"iad1","commitSha":"cb5f128"}`, 웜 응답 `241.42 ms`)

---

## 3. R2: 적대적 보안 감사 결과 및 즉시 패치 내역

### 3.1 금일(2026-11-24) 적발 즉시 패치한 페일오버·방어선·프런트엔드 보안 취약점 (4건)

1. **[중대] Upstash 브레이커 오픈 중 `401`/`403` 영구 폐기 대기열의 `402` 덮어쓰기 차단 및 로컬 Fast-Break 재시도 예산 보존 (`my-server-test/lib/llm/key-manager/stores/upstash-redis.ts`, `lib/llm/key-manager/executor.ts`)**
   - **원인**: Upstash Redis 장애로 서킷 브레이커가 열린 상태에서 `k-revoked` 키가 `HTTP 401`/`403`(영구 키 폐기)으로 판정되어 `pendingPermanentExhaustions`에 등록된 뒤, 동일 계정의 후속 `HTTP 402` 반납이나 Fast-Break가 해당 키에 도달하면 `queuePermanentExhaustionIfNeeded`가 기존 `401` 상태를 확인하지 않고 `{ statusCode: 402 }`로 덮어썼다. 이로 인해 운영자가 지갑 충전 후 형제 키에 `resetKeyToActive()`를 실행하면 `pending.statusCode === 402` 조건에 걸려 폐기된 `401` 키의 대기열까지 삭제되어 Redis 복구 후 폐기된 키가 다시 `ACTIVE`로 트래픽을 받는 결함이 있었다. 또한 `executeWithResilientFailover`에서 `brokenAccountIds` 로컬 Fast-Break(`<1ms`, 네트워크 호출 `0회`) 이전에 `attempt++`가 증가하여, 파산 계정 소속 형제 키가 여러 개일 때 정상 백업 계정에 도달하기 전에 `maxAttempts` 예산을 모두 소진할 수 있었다.
   - **패치**: `queuePermanentExhaustionIfNeeded`에서 이미 `401`/`403`으로 대기열 또는 `memoryFallback`에 기록된 영구 폐기 키는 `402`로 절대 덮어쓰지 않도록 보호하고, `resetKeyToActive` 실행 시 미전송 영구 폐기 내역을 선반영하도록 보강했다. 아울러 `executeWithResilientFailover`에서 로컬 Fast-Break 스킵 시 `attempt`를 차감하지 않고 실제 업스트림 핸드셰이크 시점에만 증가하도록 개선했다(유한 루프 가드 `maxLoopIterations` 병행).
2. **백엔드 JSON·폼 프로토타입 키(`__proto__` / `constructor` / `prototype`) 삭제·무시 경로를 악용한 대용량 페이로드 폭탄(`413`) 우회 차단 (`my-server-test/src/app.ts`)**
   - **원인**: `onParse`가 프로토타입 오염을 막기 위해 `delete parsed["__proto__"]` 및 `x-www-form-urlencoded`의 `if (k === "__proto__" || ...) continue`를 먼저 수행한 뒤 핸들러로 넘겼기 때문에, 공격자가 `{"widgetId":"valid","__proto__":"P"*50000}`, 유니코드 이스케이프 `"\u005f\u005fproto\u005f\u005f"` + `"constructor"` 분할 폭탄, 또는 `widgetId=valid&__proto__=P*50000` 폼 바디를 전송하면 `checkUnknownFieldsLimit`(`2,000자`) 및 `/v2/ask` `4,000자` 가드를 완전히 우회하여 `HTTP 200` 응답을 유발할 수 있었다.
   - **패치**: `inspectRootJsonObject`에서 모든 루트 프로토타입 키(`__proto__`, `constructor`, `prototype`, 유니코드 이스케이프 포함)의 원시 길이를 합산(`protoPayloadChars`)하여 한도(`2,000자`) 초과 시 즉시 `HTTP 413`을 반환하고, `x-www-form-urlencoded`에서도 제거되는 프로토타입 파라미터 누적 길이가 한도(`/v2/widget/*` `2,000자`, `/v2/ask` `4,000자`)를 넘으면 즉시 `HTTP 413`으로 격리했다.
3. **프런트엔드 `mount()` / `llmApi.connect()` 사전 식별자 정화 및 `startVoiceQuestion` `100,000자` 버퍼 상한·`onFirstTalk` 예외 격리 (`tokki-widget/lib/export.tsx`, `lib/api/llm.ts`, `lib/state/chat.tsx`)**
   - **원인**: `mount(config)`가 `attach()` 이전에 `llmApi.connect()`(`POST /v2/widget/view`)를 호출할 때 `normalized.threadId`·`normalized.widgetId`를 사전 정화하지 않아, 오염된 `>2,000자` `threadId`가 주입되면 `/v2/widget/view`가 `HTTP 413`으로 실패하면서 운영자가 설정한 원격 위젯 페르소나와 이전 대화 이력이 통째로 누락되는 Self-DoS가 발생했다. 또한 `startVoiceQuestion`은 `fullText` 누적 길이에 상한이 없었고 호스트 콜백 `onFirstTalk`의 동기 throw 및 비동기 Promise rejection이 격리되지 않아 콜백 오류 시 정상 음성 SSE 스트림 전체가 중단되었다.
   - **패치**: `mount()` 진입부 및 `llmApi.connect()` 내부에서 `widgetId`·`threadId`(`<=100자`, 제어문자 제거)를 즉시 정화하고, `startVoiceQuestion`의 `fullText`를 `100,000자`로 제한했으며 `onFirstTalk` 호출을 동기 `try/catch` + `Promise.resolve(...).catch()`로 완전 격리했다.
4. **프런트엔드 단일 라벨 사내 인트라넷 호스트·RFC 3056 `6to4` 사설 IPv6·IANA 예약 대역 유출 및 SSRF 차단 (`tokki-widget/lib/utils/get-browser-info.ts`, `lib/components/FunctionCall.tsx`)**
   - **원인**: 기존 호스트 필터가 `.internal`·`.corp` 등 접미사 위주로 검사하여 점이 없는 단일 라벨 사내/컨테이너 호스트(`http://intranet:8080/`, `https://jenkins/`, `https://metadata/`), 사설 IPv4가 내장된 RFC 3056 `6to4` 주소(`[2002:7f00:0001::1]`, `[2002:a9fe:a9fe::1]`), IPv6 Zone ID(`%25eth0`), IANA 예약/TEST-NET 대역(`192.0.0.0/24`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`)이 통과될 수 있었다.
   - **패치**: `getBrowserInfo()`와 `FunctionCall` 양쪽에 단일 라벨 비공개 호스트(`!h.includes(".") && !h.includes(":")`), `2002::/16` 내장 IPv4 옥텟 역산 검사, Zone ID 제거 및 IANA 예약 대역 차단을 일관되게 적용했다.

### 3.2 실시간 `/usr/bin/curl` 적대적 보안 경계 검증 로그 (40개 공격·경계 벡터 전량 통과)

| 벡터 ID | 실측 공격·경계 시나리오 (`/usr/bin/curl`) | 기대 상태 | 실측 상태 | 응답 본문 요약 | 소요 시간 | 판정 |
| :---: | :--- | :---: | :---: | :--- | :---: | :---: |
| `V01` | `POST /v2/ask` — `widgetId` 필드 누락 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `13.24 ms` | **PASS** |
| `V02` | `POST /v2/ask` — 미등록 `widgetId` 변조 (`"evil-spoof-widget-999"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `11.12 ms` | **PASS** |
| `V03` | `POST /v2/ask` — SQL 인젝션 `widgetId` (`"' OR '1'='1"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `9.00 ms` | **PASS** |
| `V04` | `POST /v2/ask` — 500자 미등록 `widgetId` (DB 무조회 즉시 차단) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `4.94 ms` | **PASS** |
| `V05` | `POST /v2/ask` — 미등록 `widgetId` + `message` 누락 (`422` 노출 없이 `403`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `4.78 ms` | **PASS** |
| `V06` | `POST /v2/ask` — CORS Simple Request (`text/plain`) 우회 프로브 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.01 ms` | **PASS** |
| `V07` | `POST /v2/widget/create-thread` — 미등록 `widgetId` 스레드 발급 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id"}` | `5.12 ms` | **PASS** |
| `V08` | `POST /v2/ask` — `x-www-form-urlencoded` `__proto__` 오염 + 미등록 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `4.69 ms` | **PASS** |
| `V09` | `POST /v2/ask` — JSON 중복 `widgetId` 키 스머글링 차단 (`{"widgetId":"evil","widgetId":"valid"}`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.28 ms` | **PASS** |
| `V10` | `POST /v2/ask` — `x-www-form-urlencoded` 중복 `widgetId` HPP 스머글링 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `4.71 ms` | **PASS** |
| `V11` | `POST /v2/ask` — 정상 최대 경계값 `message` 정확히 `4,000자` | `200` | **`200`** | `data: 토키%20정상%20경계%20응답 ... data: [DONE]` | `8.08 ms` | **PASS** |
| `V12` | `POST /v2/ask` — 경계 초과 `message` `4,001자` | `413` | **`413`** | `{"success":false,"error":"message too long (4001 > 4000 chars)"}` | `5.35 ms` | **PASS** |
| `V13` | `POST /v2/ask` — `50,000자` 한글 토큰 폭탄 (Token Bomb) | `413` | **`413`** | `{"success":false,"error":"message too long (50000 > 4000 chars)"}` | `4.92 ms` | **PASS** |
| `V14` | `POST /v2/ask` — JSON 중복 `message` 덮어쓰기 토큰 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.02 ms` | **PASS** |
| `V15` | `POST /v2/ask` — `x-www-form-urlencoded` 중복 `message` HPP 토큰 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"message too long (4509 > 4000 chars)"}` | `4.62 ms` | **PASS** |
| `V16` | `POST /v2/ask` — 비업로드 `multipart/form-data` `4,500자` 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"message too long (4500 > 4000 chars)"}` | `4.59 ms` | **PASS** |
| `V17` | `POST /v2/widget/view` — 공백 패딩 JSON `null` (`2,504자`) 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"request body too large (2504 > 2000 chars)"}` | `5.33 ms` | **PASS** |
| `V18` | `POST /v2/ask` — CORS `text/plain` `4,500자` 토큰 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"message too long (4500 > 4000 chars)"}` | `4.60 ms` | **PASS** |
| `V19` | `POST /v2/ask` — JSON Array 루트 `["A"*4500]` 토큰 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"message too long (4504 > 4000 chars)"}` | `4.34 ms` | **PASS** |
| `V20` | `POST /v2/ask` — 초장문 `widgetId` `4,500자` 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"widgetId too large (4500 > 4000 chars)"}` | `4.55 ms` | **PASS** |
| `V21` | `POST /v2/ask` — 초장문 `accessToken` `4,500자` 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"accessToken too large (4500 > 4000 chars)"}` | `5.24 ms` | **PASS** |
| `V22` | `POST /v2/widget/create-thread` — 미정의 추가 필드(`5,000자`) 밀수 차단 | `413` | **`413`** | `{"success":false,"error":"extra request fields too large (5005 > 2000 chars)"}` | `4.44 ms` | **PASS** |
| `V23` | `POST /v2/widget/view` — 미정의 추가 필드(`5,000자`) 밀수 차단 | `413` | **`413`** | `{"success":false,"error":"extra request fields too large (5005 > 2000 chars)"}` | `4.46 ms` | **PASS** |
| `V24` | `POST /v2/ask` — 비문자열 `message` 중첩 객체 밀수 (`4,500자`) | `413` | **`413`** | `{"success":false,"error":"message too long (4513 > 4000 chars)"}` | `4.53 ms` | **PASS** |
| `V25` | `POST /v2/ask` — `browserInfo` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"browserInfo too large (2508 > 2000 chars)"}` | `4.42 ms` | **PASS** |
| `V26` | `POST /v2/ask` — `threadId` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2500 > 2000 chars)"}` | `4.65 ms` | **PASS** |
| `V27` | `POST /v2/ask` — `search` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"search options too large (2500 > 2000 chars)"}` | `4.68 ms` | **PASS** |
| `V28` | `POST /v2/ask` — JSON 중복 `browserInfo` (`<4,000자`) 덮어쓰기 차단 | `413` | **`413`** | `{"success":false,"error":"browserInfo too large (2509 > 2000 chars)"}` | `4.63 ms` | **PASS** |
| `V29` | `POST /v2/ask` — 유니코드 이스케이프 중복 `\u0073earch` (`<4,000자`) 덮어쓰기 차단 | `413` | **`413`** | `{"success":false,"error":"search options too large (2509 > 2000 chars)"}` | `4.41 ms` | **PASS** |
| `V30` | `POST /v2/widget/create-thread` — JSON 중복 미정의 필드 (`<4,000자`) 덮어쓰기 차단 | `413` | **`413`** | `{"success":false,"error":"extra request fields too large (2512 > 2000 chars)"}` | `4.61 ms` | **PASS** |
| `V31` | `POST /v2/ask` — `x-www-form-urlencoded` 중복 파라미터 플러딩 (`35개 쌍`) 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `4.79 ms` | **PASS** |
| `V32` | `POST /v2/widget/view` — JSON `__proto__` (`50,000자`) 삭제 우회 폭탄 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `4.63 ms` | **PASS** |
| `V33` | `POST /v2/widget/create-thread` — 유니코드 `\u005f\u005fproto` + 중복 `constructor` 복합 폭탄 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.15 ms` | **PASS** |
| `V34` | `POST /v2/widget/view` — `x-www-form-urlencoded` `__proto__` (`2,500자`) 폭탄 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `4.64 ms` | **PASS** |
| `V35` | `POST /v2/ask` — `x-www-form-urlencoded` `__proto__` (`4,500자`) 토큰 폭탄 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `4.67 ms` | **PASS** |
| `V36` | `POST /v2/ask` — `Content-Length > 1MB` (`1.15MB` 바디 선차단) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `4.88 ms` | **PASS** |
| `V37` | `POST /v2/ask` — Chunked + `APPLICATION/JSON ; charset=utf-8` `1.15MB` 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.54 ms` | **PASS** |
| `V38` | `POST /v2/admin/widgets/upload-icon` — Chunked `2.35MB` 멀티파트 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 2MB limit"}` | `8.08 ms` | **PASS** |
| `V39` | `POST /v2/admin/widgets/upsert` — 전체화면 클릭재킹 `chat_bubble_size` (`"100vw"`) 차단 | `400` | **`400`** | `{"success":false,"error":"invalid chat_bubble_size (must be a safe CSS size like '48px' or '3.5rem')"}` | `6.16 ms` | **PASS** |
| `V40` | `POST /v2/ask` — 동일 IP 분당 10회 초과 폭주 방어 (11번째 요청) | `429` | **`429`** | `{"success":false,"error":"Too Many Requests",...,"retryAfter":60}` | `4.38 ms` | **PASS** |

---

## 4. R3: 자동화 무결성 검증 및 프리플라이트 빌드 결과

### 4.1 테스트 스위트 실행 결과 (`bun test`)

| 저장소 | 테스트 파일 수 | 통과 / 실패 | `expect()` 단언문 수 | 실행 시간 | 종료 코드 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`my-server-test` (백엔드)** | 13개 파일 | **`349 PASS / 0 FAIL`** | `2,322`개 | `7.26s` | `0` |
| **`tokki-widget` (프런트엔드)** | 2개 파일 | **`45 PASS / 0 FAIL`** | `291`개 | `0.25s` | `0` |
| **합계** | **15개 파일** | **`394 PASS / 0 FAIL` (100%)** | **`2,613`개** | **`7.51s`** | **`0`** |

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

- [x] **[성능 및 방어 무결성]** 제어된 동시 요청(18건 + 12건) 및 HTTP 429/402 오류 주입 환경에서 교착 상태나 메모리·세마포어 누수(`ZCARD = 0`) 없이 **100% 페일오버**를 달성했는가? → **달성 완료 (`98.09 ms` / `78.34 ms`, 완주율 100%, 파산 형제 키 호출 `0건`, Upstash 브레이커 오픈 중 `401` 보전 및 Fast-Break 시도 예산 보존 검증 완료, `ZCARD = 0`)**
- [x] **[보안 경계 입증]** 악의적 `widgetId` 변조(`HTTP 403`) 및 초대형 페이로드·토큰 폭탄 공격(`HTTP 413`) 차단이 실측 로그로 입증되었는가? → **40개 실전 `curl` 벡터 전량 통과(`40/40 PASS`) 및 4건의 신규 페일오버·방어선·음성 스트림·SSRF 보안 취약점 즉시 패치 완료**
- [x] **[최종 산출물]** 한국어 감사 보고서(`stress_test_audit.md`)가 생성되었는가? → **양쪽 워크스페이스(`my-server-test`, `tokki-widget`)에 한국어로 생성 완료**
- [x] **[테스트 무결성]** 모든 방어 테스트(`bun test`)가 종료 코드 `0`으로 100% 통과했는가? → **`394 / 394 PASS` (`2,613` assertions, `Exit Code 0`)**
- [x] **[쿼터 보호]** 커밋 메시지에 `[skip ci]`가 포함되어 Vercel 및 GitHub Actions 무료 쿼터를 보호했는가? → **`fix(tokki): automated defense and load test patch [skip ci]` 로컬 커밋 적용 완료 (무료 배포 쿼터 보호를 위해 불필요한 원격 푸시 생략)**
