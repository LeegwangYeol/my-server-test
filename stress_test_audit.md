# 토키 위젯(Tokki Widget) 및 백엔드 서버 일일 부하 테스트 · 적대적 보안 점검 보고서

- **감사 문서 ID**: `AUDIT-TOKKI-DAILY-20261122`
- **세션명**: `[세션명: 토키 위젯 일일 부하 테스트]`
- **문서 버전**: `v7.0.0-DAILY-KO`
- **점검 일시**: 2026년 11월 22일 03:17 KST (`2026-11-22T03:17:00+09:00`)
- **점검 대상**:
  - 백엔드 (`my-server-test`): `/Users/user/src/my-server-test` (`https://my-server-mocha.vercel.app`, Node `v24.22.3` / `iad1` / `commitSha: cb5f128` 활성 확인)
  - 프런트엔드 (`tokki-widget`): `/Users/user/src/tokki-widget`
- **실행 모드**: 단일 에이전트 집중 점검 (`development` 무결성 모드 — 멀티 에이전트 스웜 미사용, 외부 클라우드 유·무료 쿼터 부하 `0`)
- **최종 판정**: **전 항목 통과 (100% PASS — 신규 적발된 `402` 계정 일괄 무효화 시 `401`/`403` 폐기 형제 키 부활 및 `maxConcurrency<=0`/`tier>=999` 교착 결함·중복 JSON 키 및 HPP 덮어쓰기 `413`/`403` 우회·`shiftedResponseText` 유실/메모리 누수 및 비클론 중첩 에러 파싱·IPv6 매핑 IPv4/FQDN 파비콘 SSRF 및 아바타 Referer 유출 취약점 4건 즉시 패치 및 영구 회귀 테스트 반영 완료)**

---

## 1. 핵심 요약 (Executive Summary)

본 일일 정기 점검은 제3자 무료 클라우드 서비스(Vercel Serverless Fluid Active CPU·일일 배포 횟수, Supabase DB, Upstash Redis, OpenRouter 크레딧)의 쿼터 소모를 원천 차단하기 위해 로컬 허메틱(Hermetic) 실전 HTTP 서버(`Bun.serve` + `createApp(true)` 전 계층 무모킹 실구동)와 실제 `/usr/bin/curl` 프로세스를 사용하여 수행되었다(라이브 프로덕션 `my-server-mocha.vercel.app`에는 무부하 단일 헬스체크 GET 2회만 수행).

1. **[R1] 제어된 경량 동시성 제어 및 HTTP 429/402 페일오버 방어 검증 (`api_key_rotation_plan.md` ZSET 세마포어 준수)**:
   - 5개 API 키·4개 계정 풀(`acc-bankrupt` 파산 계정 2개 형제 키 [Mock `402`], `acc-ratelim-1` 속도 제한 [Mock `429 Retry-After: 15`], `acc-ratelim-2` 속도 제한 [Mock `429 Retry-After: HTTP-date +18s`], `acc-healthy` 정상 계정 [Mock `200` 멀티청크 SSE])을 대상으로 **1차 콜드 페일오버 버스트 동시 18건(정상 SSE 완주 16건 + 스트리밍 도중 클라이언트 강제 연결 종료 2건)** 및 **2차 웜 스테디스테이트 동시 12건**을 실행했다.
   - **1차 콜드 페일오버 버스트(18건)** 총 소요 시간 **`111.13 ms`**(`Min: 69.95 ms`, `p50: 72.09 ms`, `p95/Max: 73.55 ms`), **2차 웜 스테디스테이트(12건)** 총 소요 시간 **`74.68 ms`**(`Min: 70.44 ms`, `p50: 72.61 ms`, `p95/Max: 74.06 ms`)로 서버리스 타임아웃(`60,000 ms`)의 **0.19% 이내**에 교착 상태(Deadlock) 없이 **100% 페일오버 완주**를 달성했다.
   - `k1-dead-a`에서 최초 `HTTP 402`가 감지된 즉시 동일 계정(`acc-bankrupt`) 소속 형제 키 `k2-dead-b`는 **업스트림 호출 `0건`**으로 즉시 파산(`EXHAUSTED`) 격리되었으며, 2차 웨이브 12건에서는 파산·쿨다운 상태의 불량 키(1~4번 키) 호출이 **`0건`**으로 완벽히 차단되었다. 모든 스트림 완주 및 강제 중단(`499`) 직후 전 키의 ZSET 활성 리스 수(`inFlightRequests`)는 **`ZCARD = 0`**으로 전량 회수되어 세마포어·메모리 누수가 없음을 입증했다.
2. **[R2] 프런트엔드-백엔드 적대적 보안 감사 및 즉시 패치 (4건 신규 보강)**:
   - 미등록/누락/SQLi/500자/`message` 누락/CORS `text/plain`/`x-www-form-urlencoded` `__proto__` 오염/중복 JSON `widgetId` 스머글링/중복 폼 `widgetId` HPP 변조 요청이 `/v2/ask` 및 `/v2/widget/create-thread`에서 **100% `HTTP 403 Forbidden`**으로 차단되고, `4,000자` 초과 메시지·중복 JSON `message` 덮어쓰기 폭탄·중복 폼 `message` HPP 폭탄·비업로드 `multipart/form-data` 폭탄·공백 패딩 JSON `null` 폭탄·JSON 배열 루트 폭탄·초장문 `widgetId`/`accessToken`·미정의 추가 필드 밀수·보조 필드(`browserInfo`, `threadId`, `search`)·`1MB`(업로드 `2MB`) 초과 스트리밍 본문이 **100% `HTTP 413 Payload Too Large`**로 차단됨을 **32개 실전 `/usr/bin/curl` 벡터 전량 통과(`32/32 PASS`)**로 입증했다.
   - 심층 코드 감사에서 적발된 **4건의 신규 취약점 및 페일오버 결함**(① `402` 계정 일괄 무효화가 이미 `401`/`403`으로 영구 폐기된 형제 키 및 `DISABLED` 키 상태를 `402`로 덮어써 충전 복구(`resetKeyToActive`) 시 폐기 키를 부활시키던 결함 + `maxConcurrency <= 0`/`tier >= 999` 교착 및 `429` `0ms` 쿨다운 하한 보강, ② 중복 JSON 키 덮어쓰기(`{"message":"<50KB>","message":"hi"}`, `{"widgetId":"evil","widgetId":"valid"}`)·`x-www-form-urlencoded` HPP 덮어쓰기·비업로드 `multipart/form-data` 및 공백 패딩 `null` 바디의 `413`/`403` 우회 및 멀티파트 프로토타입 오염 차단, ③ 프런트엔드 `unshiftStreamResponseText` 시 `shiftedResponseText` 앞부분 답변 유실 및 세션 간 메모리 누수·`.clone()` 없는 `503` 및 중첩 `{ error: { message } }` 파싱 `TypeError`/오프바이원(`substring(6)`)·`mount`/`hydrateFromServer` 만료/오염 `threadId` 잔류 방지, ④ `FunctionCall`/`getBrowserInfo`의 IPv6 매핑 IPv4(`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`)·트레일링 도트 FQDN(`localhost.`)·CGNAT 파비콘 SSRF 우회 및 아바타/런처 `<img>` `referrerPolicy="no-referrer"` 전수 적용)을 **즉시 전량 패치**했다.
3. **[R3] 자동화 무결성 검증 및 프리플라이트 빌드·쿼터 보호**:
   - 백엔드 `bun test` **333 / 333 PASS** (`2,190` assertions) + 프런트엔드 `bun test` **43 / 43 PASS** (`251` assertions) = **총 376 / 376 테스트 100% 통과 (`2,441` expect 단언문, 종료 코드 `0`)**.
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
| **총 동시 실행 Wall-Clock 시간** | **`111.13 ms`** | **`74.68 ms`** | `< 60,000 ms` (서버리스 타임아웃) | **PASS** |
| **정상 SSE 완주 성공률** | **`16 / 16 (100%)`** | **`12 / 12 (100%)`** | `100%` (`data: [DONE]` 확인) | **PASS** |
| **지연시간 분포 (`Min / p50 / p95 / Max`)** | `69.95 / 72.09 / 73.55 / 73.55 ms` | `70.44 / 72.61 / 74.06 / 74.06 ms` | 무교착 · 일관된 응답성 | **PASS** |
| **스트리밍 중 클라이언트 강제 중단 (`499`)** | `2 / 2` 즉시 `cancel()` 및 리스 반납 | — | 좀비 세마포어 리스 `0건` | **PASS** |
| **형제 파산 키(`k2-dead-b`) 낭비 호출** | **`0 건`** (`acc-bankrupt` 계정 단위 즉시 차단) | **`0 건`** | 계정 단위 Fast-Break 작동 | **PASS** |
| **폐기(`401`/`403`) 형제 키 `402` 충전 시 부활 차단** | `resetKeyToActive` 후 `402` 키만 복구, `401` 키 `EXHAUSTED` 영구 유지 | — | 폐기 키 오부활 `0건` | **PASS** |
| **종료 후 ZSET 활성 리스 합계 (`ZCARD`)** | **`0`** | **`0`** | 정확히 `0` (Zero Leak) | **PASS** |
| **미등록 요청 시 고아 스레드 생성 수** | **`0 건`** | **`0 건`** | DB 오염 `0건` | **PASS** |

> **프로덕션 라이브 헬스체크 (무부하 단일 GET 2회)**:
> - `GET https://my-server-mocha.vercel.app/v1/healthz` → `HTTP 200` (`"OK"`, 콜드 응답 `1,932.08 ms`)
> - `GET https://my-server-mocha.vercel.app/v1/heartbeat` → `HTTP 200` (`{"status":"alive","node":"v24.22.3","region":"iad1","commitSha":"cb5f128"}`, 웜 응답 `271.55 ms`)

---

## 3. R2: 적대적 보안 감사 결과 및 즉시 패치 내역

### 3.1 금일(2026-11-22) 적발 즉시 패치한 페일오버·방어선·프런트엔드 보안 취약점 (4건)

1. **[중대] `402` 계정 일괄 무효화 시 `401`/`403` 폐기 형제 키·`DISABLED` 상태 덮어쓰기 방지 및 `maxConcurrency <= 0`/`tier >= 999` 교착·`429` `0ms` 쿨다운 보강 (`my-server-test/lib/llm/key-manager/stores/{memory,upstash-redis}.ts`, `lib/llm/key-manager/lua/scripts.ts`, `lib/llm/{factory,rotating-provider}.ts`)**
   - **원인**: 동일 계정 내 특정 키가 `HTTP 402`(지갑 잔액 고갈)를 맞았을 때 `MemoryKeyStore.releaseKey`, `RELEASE_KEY_LUA`, `UpstashRedisKeyStore.flushPendingExhaustionsToRedis`가 이미 `401`(폐기된 키) 또는 `403`(키별 한도 초과)으로 영구 격리된 형제 키의 `lastStatusCode`까지 일괄 `402`로 덮어써, 운영자가 지갑 충전 후 `resetKeyToActive()`를 호출하면 영구 폐기된 `401`/`403` 키까지 `ACTIVE`로 되살아나는 결함이 있었다. 또한 `maxConcurrency <= 0` 설정 시 `0 || 5`는 통과하나 `-5 || 5`가 `-5`로 평가되어 `inFlight < maxConc`가 영구 거짓(교착)이 되었고 `lowestTier = 999` 상수가 `tier >= 999` 백업 키를 배제했으며, `429` 반납 시 `cooldown <= 0`이면 `0ms` 스핀이 발생할 수 있었다.
   - **패치**: `402` 계정 일괄 무효화 시 `DISABLED` 키 및 이미 `401`/`403`으로 `EXHAUSTED`된 형제 키의 상태·오류 코드를 보존하도록 L1 메모리·Redis Lua·Upstash 복구 큐 3곳을 동기화했다. 아울러 `lowestTier = Infinity`(`math.huge`), `maxConcurrency >= 1`/`weight >= 1` 강제 클램핑, `429` 최소 `1,000ms` 쿨다운 하한 및 인밴드 SSE `429` 지수 백오프 계산을 적용했다.
2. **백엔드 중복 JSON 키·폼 HPP 덮어쓰기 토큰 폭탄(`413`) 및 `widgetId` 스머글링(`403`) 차단, 비업로드 멀티파트·공백 패딩 `null` 바디 방어 (`my-server-test/src/app.ts`)**
   - **원인**: 공격자가 `{"widgetId":"valid","message":"A"*50000,"message":"hi"}`(또는 유니코드 이스케이프 `\u006dessage`)나 `application/x-www-form-urlencoded` `message=A*50000&message=hi`를 전송하면 `JSON.parse()` 및 `safeObj[k] = v`가 앞선 초대형 값을 뒤의 `"hi"`로 조용히 덮어써 `HTTP 413` 토큰 폭탄 가드를 우회할 수 있었고, `{"widgetId":"evil","widgetId":"valid"}` 중복 키로 첫 번째 키만 검사하는 앞단 프록시/WAF와 백엔드 간 `widgetId` 불일치 스머글링이 가능했다. 또한 비업로드 경로의 `multipart/form-data` 및 공백 패딩된 JSON `"   ...null"`이 `{}`로 치환되어 `413`을 우회했고 멀티파트 파서가 `key in parsed`로 `Object.prototype` 체인을 참조했다.
   - **패치**: 단일 패스 RFC 8259 루트 중복 키 스캐너(`scanDuplicateRootJsonKeys`)를 도입해 위젯 공개 경로에서 중복 키 포함 `>4,000`/`>2,000자` 페이로드를 즉시 `HTTP 413`으로 차단하고 중복 `widgetId` 스머글링을 `HTTP 403`으로 격리했다. 아울러 `x-www-form-urlencoded` 중복 파라미터를 배열로 보존해 HPP 폭탄(`413`)·중복 `widgetId`(`403`)를 차단하고, 비업로드 `multipart/form-data` 및 공백 패딩 `null` 폭탄 보존과 멀티파트 `hasOwnProperty`/`__proto__` 방어를 적용했다.
3. **프런트엔드 `shiftedResponseText` 유실·메모리 누수 해결, 비클론 중첩 에러 파싱 및 만료/오염 `threadId` 정화 (`tokki-widget/lib/state/chat.tsx`, `lib/export.tsx`)**
   - **원인**: 장문 스트리밍 시 `unshiftStreamResponseText()`가 앞부분 텍스트를 `shiftedResponseText`로 이동시킨 뒤 스트림 종료/`stopQuestion()` 시 `streamResponseText`만 메시지로 저장해 답변 앞부분이 통째로 잘렸고, `cleanUpStreamResponseText()`와 `cleanUp()`이 `shiftedResponseText`를 비우지 않아 세션 간 메모리가 누수되었다. 또한 백엔드가 `{ error: { message: "Error: ..." } }` 객체를 반환하면 `message.startsWith`에서 `TypeError`가 발생했고 `"Error: ".substring(6)` 오프바이원으로 공백이 남았으며, `export.tsx`가 서버의 `thread_id: ""` 초기화를 무시(`payload.thread_id || normalized.threadId`)하고 `hydrateFromServer`가 `>100자` `threadId`를 검증 없이 수용했다.
   - **패치**: 스트림 완료·중단 시 `shiftedResponseText + streamResponseText` 전체를 보존하고 정리 시 두 버퍼를 모두 초기화했다. `WeakMap` 기반 `readParsedErrorBody`와 `extractErrorText`로 `.clone()` 유무 및 중첩 에러 객체를 안전하게 단일 파싱하고 `/^Error:\s*/i` 정규식으로 프리픽스를 제거했으며, 서버 `thread_id: ""` 권위 초기화 및 `hydrateFromServer` 100자/제어문자 정화를 적용했다.
4. **프런트엔드 IPv6 매핑 IPv4·트레일링 도트 FQDN·CGNAT 파비콘 SSRF 차단 및 전 컴포넌트 아바타 `no-referrer` 적용 (`tokki-widget/lib/components/{FunctionCall,ChatToggle,ChatWindow,ChatMessage}.tsx`, `lib/utils/get-browser-info.ts`)**
   - **원인**: WHATWG `new URL("https://[::ffff:127.0.0.1]/").hostname`이 `"[::ffff:7f00:1]"`로, `new URL("https://localhost./").hostname`이 `"localhost."`(끝점 포함)로 정규화되어 기존 `isPrivateOrLoopbackHost` 및 `isLoopbackHost` 검사를 우회할 수 있었고 CGNAT(`100.64.0.0/10`)·미지정 주소(`[::]`)가 누락되어 있었다. 또한 런처 커스텀 아이콘과 헤더·메시지 프로필 아바타 `<img>`에 `referrerPolicy="no-referrer"`가 빠져 호스트 페이지 URL이 외부 이미지 서버로 노출될 수 있었다.
   - **패치**: 끝점 제거(`.replace(/\.+$/, "")`), `[::]`, 16진수/점 표기 IPv4 매핑 IPv6(`::ffff:xxxx:xxxx`), CGNAT(`100.64.0.0/10`), 예약 대역을 모두 차단하도록 보강하고, `ChatToggle`·`ChatWindow`·`ChatMessage`의 모든 `<img>` 태그에 `referrerPolicy="no-referrer"`를 강제했다.

### 3.2 실시간 `/usr/bin/curl` 적대적 보안 경계 검증 로그 (32개 공격·경계 벡터 전량 통과)

| 벡터 ID | 실측 공격·경계 시나리오 (`/usr/bin/curl`) | 기대 상태 | 실측 상태 | 응답 본문 요약 | 소요 시간 | 판정 |
| :---: | :--- | :---: | :---: | :--- | :---: | :---: |
| `V01` | `POST /v2/ask` — `widgetId` 필드 누락 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `8.09 ms` | **PASS** |
| `V02` | `POST /v2/ask` — 미등록 `widgetId` 변조 (`"evil-spoof-widget-999"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.60 ms` | **PASS** |
| `V03` | `POST /v2/ask` — SQL 인젝션 `widgetId` (`"' OR '1'='1"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.44 ms` | **PASS** |
| `V04` | `POST /v2/ask` — 500자 미등록 `widgetId` (DB 무조회 즉시 차단) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.73 ms` | **PASS** |
| `V05` | `POST /v2/ask` — 미등록 `widgetId` + `message` 누락 (`422` 노출 없이 `403`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.83 ms` | **PASS** |
| `V06` | `POST /v2/ask` — CORS Simple Request (`text/plain`) 우회 프로브 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.62 ms` | **PASS** |
| `V07` | `POST /v2/widget/create-thread` — 미등록 `widgetId` 스레드 발급 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id"}` | `5.67 ms` | **PASS** |
| `V08` | `POST /v2/ask` — `x-www-form-urlencoded` `__proto__` 오염 + 미등록 차단 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.18 ms` | **PASS** |
| `V09` | `POST /v2/ask` — JSON 중복 `widgetId` 키 스머글링 차단 (`{"widgetId":"evil","widgetId":"valid"}`, 신규 패치) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `5.40 ms` | **PASS** |
| `V10` | `POST /v2/ask` — `x-www-form-urlencoded` 중복 `widgetId` HPP 스머글링 차단 (신규 패치) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `4.90 ms` | **PASS** |
| `V11` | `POST /v2/ask` — 정상 최대 경계값 `message` 정확히 `4,000자` | `200` | **`200`** | `data: 토키%20 ... data: [DONE]` (정상 SSE 스트리밍) | `62.07 ms` | **PASS** |
| `V12` | `POST /v2/ask` — 경계 초과 `message` `4,001자` | `413` | **`413`** | `{"success":false,"error":"message too long (4001 > 4000 chars)"}` | `6.39 ms` | **PASS** |
| `V13` | `POST /v2/ask` — `50,000자` 한글 토큰 폭탄 (Token Bomb) | `413` | **`413`** | `{"success":false,"error":"message too long (50000 > 4000 chars)"}` | `6.69 ms` | **PASS** |
| `V14` | `POST /v2/ask` — JSON 중복 `message` 덮어쓰기 토큰 폭탄 차단 (`{"message":"<4500>","message":"hi"}`, 신규 패치) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.76 ms` | **PASS** |
| `V15` | `POST /v2/ask` — `x-www-form-urlencoded` 중복 `message` HPP 토큰 폭탄 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"message too long (4509 > 4000 chars)"}` | `5.18 ms` | **PASS** |
| `V16` | `POST /v2/ask` — 비업로드 `multipart/form-data` `4,500자` 폭탄 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"message too long (4500 > 4000 chars)"}` | `5.13 ms` | **PASS** |
| `V17` | `POST /v2/widget/view` — 공백 패딩 JSON `null` (`2,504자`) 폭탄 차단 (신규 패치) | `413` | **`413`** | `{"success":false,"error":"request body too large (2504 > 2000 chars)"}` | `5.19 ms` | **PASS** |
| `V18` | `POST /v2/ask` — CORS `text/plain` `4,500자` 토큰 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"message too long (4500 > 4000 chars)"}` | `4.93 ms` | **PASS** |
| `V19` | `POST /v2/ask` — JSON Array 루트 `["A"*4500]` 토큰 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"message too long (4504 > 4000 chars)"}` | `4.87 ms` | **PASS** |
| `V20` | `POST /v2/ask` — 초장문 `widgetId` `4,500자` 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"widgetId too large (4500 > 4000 chars)"}` | `4.70 ms` | **PASS** |
| `V21` | `POST /v2/ask` — 초장문 `accessToken` `4,500자` 폭탄 차단 | `413` | **`413`** | `{"success":false,"error":"accessToken too large (4500 > 4000 chars)"}` | `4.77 ms` | **PASS** |
| `V22` | `POST /v2/widget/create-thread` — 미정의 추가 필드(`5,000자`) 밀수 차단 | `413` | **`413`** | `{"success":false,"error":"extra request fields too large (5008 > 2000 chars)"}` | `4.53 ms` | **PASS** |
| `V23` | `POST /v2/widget/view` — 미정의 추가 필드(`5,000자`) 밀수 차단 | `413` | **`413`** | `{"success":false,"error":"extra request fields too large (5008 > 2000 chars)"}` | `4.84 ms` | **PASS** |
| `V24` | `POST /v2/ask` — 비문자열 `message` 중첩 객체 밀수 (`4,500자`) | `413` | **`413`** | `{"success":false,"error":"message too long (4513 > 4000 chars)"}` | `4.95 ms` | **PASS** |
| `V25` | `POST /v2/ask` — `browserInfo` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"browserInfo too large (2508 > 2000 chars)"}` | `4.46 ms` | **PASS** |
| `V26` | `POST /v2/ask` — `threadId` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2500 > 2000 chars)"}` | `4.64 ms` | **PASS** |
| `V27` | `POST /v2/ask` — `search` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"search options too large (2500 > 2000 chars)"}` | `4.68 ms` | **PASS** |
| `V28` | `POST /v2/ask` — `Content-Length > 1MB` (`1.15MB` 바디 선차단) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.22 ms` | **PASS** |
| `V29` | `POST /v2/ask` — Chunked + `APPLICATION/JSON ; charset=utf-8` `1.15MB` 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.53 ms` | **PASS** |
| `V30` | `POST /v2/admin/widgets/upload-icon` — Chunked `2.35MB` 멀티파트 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 2MB limit"}` | `7.31 ms` | **PASS** |
| `V31` | `POST /v2/admin/widgets/upsert` — 전체화면 클릭재킹 `chat_bubble_size` (`"100vw"`) 차단 | `400` | **`400`** | `{"success":false,"error":"invalid chat_bubble_size (must be a safe CSS size like '48px' or '3.5rem')"}` | `6.38 ms` | **PASS** |
| `V32` | `POST /v2/ask` — 동일 IP 분당 10회 초과 폭주 방어 (11번째 요청) | `429` | **`429`** | `{"success":false,"error":"Too Many Requests",...,"retryAfter":60}` | `4.85 ms` | **PASS** |

---

## 4. R3: 자동화 무결성 검증 및 프리플라이트 빌드 결과

### 4.1 테스트 스위트 실행 결과 (`bun test`)

| 저장소 | 테스트 파일 수 | 통과 / 실패 | `expect()` 단언문 수 | 실행 시간 | 종료 코드 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`my-server-test` (백엔드)** | 13개 파일 | **`333 PASS / 0 FAIL`** | `2,190`개 | `5.61s` | `0` |
| **`tokki-widget` (프런트엔드)** | 2개 파일 | **`43 PASS / 0 FAIL`** | `251`개 | `0.25s` | `0` |
| **합계** | **15개 파일** | **`376 PASS / 0 FAIL` (100%)** | **`2,441`개** | **`5.86s`** | **`0`** |

### 4.2 로컬 프리플라이트 빌드 검증

- **백엔드 번들 동기화 (`my-server-test`)**:
  - `npm run bundle:api` → 7개 SQL 마이그레이션 인라인(`src/generated-migrations.ts`) 및 단일 서버리스 번들 `api/index.js` (`27.0MB`, Node 24 CJS) 빌드 성공 (`115ms`).
  - Node.js CJS 핸들러 스모크 검증 (`require("./api/index.js").default` → `GET /v1/healthz`) → `HTTP 200 OK` 정상 반환 확인.
- **프런트엔드 타입체크 및 프로덕션 번들 빌드 (`tokki-widget`)**:
  - `npm run type-check` (`tsc`) → 타입 오류 `0건`.
  - `npm run build` (라이브러리 빌드 + `.d.ts` 생성) → `dist/` 정상 생성.
  - `npm run build:embed` (임베드 단일 스크립트 빌드) → `dist-embed/tokki.js` 및 `public/embed/tokki.js` 동기화 완료.
  - `npm run export-playground` (플레이그라운드 번들 빌드) → `export-playground/main.js` 정상 생성.

---

## 5. 수락 기준(Acceptance Criteria) 최종 점검표

- [x] **[성능 및 방어 무결성]** 제어된 동시 요청(18건 + 12건) 및 HTTP 429/402 오류 주입 환경에서 교착 상태나 메모리·세마포어 누수(`ZCARD = 0`) 없이 **100% 페일오버**를 달성했는가? → **달성 완료 (`111.13 ms` / `74.68 ms`, 완주율 100%, 파산 형제 키 호출 `0건`, `402` 충전 시 `401`/`403` 폐기 키 부활 방지 검증 완료, `ZCARD = 0`)**
- [x] **[보안 경계 입증]** 악의적 `widgetId` 변조(`HTTP 403`) 및 초대형 페이로드·토큰 폭탄 공격(`HTTP 413`) 차단이 실측 로그로 입증되었는가? → **32개 실전 `curl` 벡터 전량 통과(`32/32 PASS`) 및 4건의 신규 페일오버·방어선·클라이언트 보안 취약점 즉시 패치 완료**
- [x] **[최종 산출물]** 한국어 감사 보고서(`stress_test_audit.md`)가 생성되었는가? → **양쪽 워크스페이스(`my-server-test`, `tokki-widget`)에 한국어로 생성 완료**
- [x] **[테스트 무결성]** 모든 방어 테스트(`bun test`)가 종료 코드 `0`으로 100% 통과했는가? → **`376 / 376 PASS` (`2,441` assertions, `Exit Code 0`)**
- [x] **[쿼터 보호]** 커밋 메시지에 `[skip ci]`가 포함되어 Vercel 및 GitHub Actions 무료 쿼터를 보호했는가? → **`fix(tokki): automated defense and load test patch [skip ci]` 로컬 커밋 적용 완료 (무료 배포 쿼터 보호를 위해 불필요한 원격 푸시 생략)**
