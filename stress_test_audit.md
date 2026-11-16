# 토키 위젯(Tokki Widget) 및 백엔드 서버 일일 부하 테스트 · 적대적 보안 점검 보고서

- **감사 문서 ID**: `AUDIT-TOKKI-DAILY-20261117`
- **세션명**: `[세션명: 토키 위젯 일일 부하 테스트]`
- **문서 버전**: `v6.5.0-DAILY-KO`
- **점검 일시**: 2026년 11월 17일 03:25 KST (`2026-11-17T03:25:00+09:00`)
- **점검 대상**:
  - 백엔드 (`my-server-test`): `/Users/user/src/my-server-test` (`https://my-server-mocha.vercel.app`, Node `v24.22.2` / `iad1` / `commitSha: cb5f128` 활성 확인)
  - 프런트엔드 (`tokki-widget`): `/Users/user/src/tokki-widget`
- **실행 모드**: 단일 에이전트 집중 점검 (`development` 무결성 모드 — 멀티 에이전트 스웜 미사용, 외부 클라우드 유·무료 쿼터 부하 `0`)
- **최종 판정**: **전 항목 통과 (100% PASS — 신규 적발된 방어선·동기화 취약점 5건 즉시 패치 및 영구 회귀 테스트 반영 완료)**

---

## 1. 핵심 요약 (Executive Summary)

본 일일 정기 점검은 외부 제3자 클라우드 무료 플랜 한도(Vercel Serverless Active CPU·일일 배포 횟수, Supabase DB, OpenRouter 크레딧)를 보호하기 위해 로컬 허메틱(Hermetic) 실전 HTTP 서버(`Bun.serve` + `createApp(true)`)와 실제 `/usr/bin/curl` 프로세스 위에서 수행되었다(라이브 프로덕션 `my-server-mocha.vercel.app`에는 무부하 단일 헬스체크 GET 2회만 수행).

1. **[R1] 제어된 경량 동시성 제어 및 HTTP 429/402 페일오버 방어 검증 (`api_key_rotation_plan.md` 준수)**:
   - 5개 API 키·4개 계정 풀(`acc-bankrupt` 파산 계정 2개 형제 키 [Mock `402`], `acc-ratelim-1` 속도 제한 [Mock `429 Retry-After: 15`], `acc-ratelim-2` 속도 제한 [Mock `429 Retry-After: HTTP-date +18s`], `acc-healthy` 정상 계정 [Mock `200` 멀티청크 SSE])을 대상으로 **1차 동시 부하 18건(정상 SSE 완주 16건 + 스트리밍 도중 클라이언트 강제 연결 종료 2건)** 및 **2차 웜 스테디스테이트 동시 부하 12건**을 실행했다.
   - **1차 콜드 페일오버 버스트(18건)** 총 소요 시간 **`89.33 ms`**(`Min: 80.41 ms`, `p50: 82.05 ms`, `p95/Max: 88.38 ms`), **2차 웜 스테디스테이트(12건)** 총 소요 시간 **`86.57 ms`**(`Min: 83.56 ms`, `p50: 84.55 ms`, `p95/Max: 86.03 ms`)로 서버리스 타임아웃(`60,000 ms`)의 **0.15% 이내**에 교착 상태(Deadlock) 없이 **100% 페일오버 완주**를 달성했다.
   - `k1-dead-a`에서 최초 `HTTP 402`가 감지된 즉시 동일 계정(`acc-bankrupt`) 소속 형제 키 `k2-dead-b`는 **업스트림 호출 `0건`**으로 즉시 파산(`EXHAUSTED`) 격리되었으며, 2차 웨이브 12건에서는 파산·쿨다운 상태의 불량 키(1~4번 키) 호출이 **`0건`**으로 완벽히 차단되었다. 모든 스트림 완주 및 강제 중단(`499`) 직후 전 키의 ZSET 활성 리스 수(`inFlightRequests`)는 **`ZCARD = 0`**으로 회수되어 세마포어·메모리 누수가 없음을 입증했다.
2. **[R2] 프런트엔드-백엔드 적대적 보안 감사 및 즉시 패치 (5건 신규 보강)**:
   - 미등록/누락/SQLi/초장문 `widgetId` 변조 요청이 `/v2/ask` 및 `/v2/widget/create-thread`에서 **100% `HTTP 403 Forbidden`**으로 차단되고, `4,000자` 초과 메시지·`2,000자` 초과 보조 필드·`1MB`(업로드 `2MB`) 초과 스트리밍 본문이 **100% `HTTP 413 Payload Too Large`**로 차단됨을 18개 실전 `curl` 벡터로 입증했다.
   - 심층 보안·동시성 코드 감사에서 발견된 **5건의 우회 가능 취약점 및 상태 비동기화 결함**(① `MarkdownPreview.tsx`의 `id`/`name` 호스트 DOM 클로버링·`style` 전체화면 클릭재킹/CSS 유출·`ping` 비콘·`srcSet` 배열 우회, ② `sanitize-url.ts`의 WHATWG 백슬래시 `/\evil.com` 및 제어문자 `/\t/evil.com` 외부 리다이렉트 우회 + `<img src>` 무검증 렌더링, ③ `chat.tsx` `startQuestion`/`startVoiceQuestion` 및 추천 질문 버튼 동일 프레임 더블클릭 시 스트림 중첩 인터리빙, ④ 백엔드 `icon_url`의 프로토콜 상대 `//evil.com`·백슬래시 `/\evil.com` 우회, ⑤ `UpstashRedisKeyStore`의 L1/L2 `mirrorReservation` 미반영으로 인한 `WARMUP` 졸업 불일치·`HTTP 408` 미회전·`syncKeys` 일시 실패 시 싱글톤 영구 오염)을 **즉시 전량 패치**했다.
3. **[R3] 자동화 무결성 검증 및 프리플라이트 빌드·쿼터 보호**:
   - 백엔드 `bun test` **304 / 304 PASS** (`1,925` assertions) + 프런트엔드 `bun test` **35 / 35 PASS** (`162` assertions) = **총 339 / 339 테스트 100% 통과 (`2,087` expect 단언문, 종료 코드 `0`)**.
   - 사전 빌드(`npm run bundle:api` → `api/index.js` `26.9MB`, `npm run type-check`, `npm run build`, `npm run build:embed`, `npm run export-playground`) 전량 무오류 통과 및 `[skip ci]` 로컬 커밋 규칙을 준수했다.

---

## 2. R1: 경량 동시성 제어 및 429/402 페일오버 방어 실측 결과

### 2.1 테스트 토폴로지 (5-Key / 4-Account ZSET 세마포어 풀)

| 키 ID | 소속 계정 (`accountId`) | 티어 / 가중치 | 오류 주입 시나리오 | 1차 웨이브 호출 수 | 2차 웨이브 호출 수 | 종료 후 상태 / 서킷 | 최종 `ZCARD` (`inFlightRequests`) |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: | :---: |
| `k1-dead-a` | `acc-bankrupt` | Tier 0 / `100` | Mock `HTTP 402` (크레딧 고갈) | `1회` | **`0회`** | `EXHAUSTED` / `OPEN` | **`0`** |
| `k2-dead-b` | `acc-bankrupt` (형제 키) | Tier 0 / `95` | 동일 계정 파산 즉시 전파 대상 | **`0회`** (Fast-Break) | **`0회`** | `EXHAUSTED` / `OPEN` | **`0`** |
| `k3-rl-delta` | `acc-ratelim-1` | Tier 0 / `85` | Mock `HTTP 429` (`Retry-After: 15`) | `1회` | **`0회`** | `RATE_LIMITED` / `OPEN` | **`0`** |
| `k4-rl-date` | `acc-ratelim-2` | Tier 0 / `75` | Mock `HTTP 429` (`Retry-After: HTTP-date`) | `1회` | **`0회`** | `RATE_LIMITED` / `OPEN` | **`0`** |
| `k5-healthy` | `acc-healthy` | Tier 1 / `60` | 정상 `HTTP 200` 4청크 SSE 스트리밍 | `18회` (완주 16 + 중단 2) | **`12회`** | `ACTIVE` / `CLOSED` | **`0`** |

### 2.2 동시 요청 지연시간(Latency) · 페일오버 · 리소스 회수 지표

| 측정 항목 | 1차 콜드 페일오버 버스트 (동시 18건: 완주 16 + 중단 2) | 2차 웜 스테디스테이트 (동시 12건) | 허용 기준 (SLA) | 판정 |
| :--- | :---: | :---: | :---: | :---: |
| **총 동시 실행 Wall-Clock 시간** | **`89.33 ms`** | **`86.57 ms`** | `< 60,000 ms` (서버리스 타임아웃) | **PASS** |
| **정상 SSE 완주 성공률** | **`16 / 16 (100%)`** | **`12 / 12 (100%)`** | `100%` (`data: [DONE]` 확인) | **PASS** |
| **지연시간 분포 (`Min / p50 / p95 / Max`)** | `80.41 / 82.05 / 88.38 / 88.38 ms` | `83.56 / 84.55 / 86.03 / 86.03 ms` | 무교착 · 일관된 응답성 | **PASS** |
| **스트리밍 중 클라이언트 강제 중단 (`499`)** | `2 / 2` 즉시 `cancel()` 및 리스 반납 | — | 좀비 세마포어 리스 `0건` | **PASS** |
| **형제 파산 키(`k2-dead-b`) 낭비 호출** | **`0 건`** (`acc-bankrupt` 계정 단위 즉시 차단) | **`0 건`** | 계정 단위 Fast-Break 작동 | **PASS** |
| **종료 후 ZSET 활성 리스 합계 (`ZCARD`)** | **`0`** | **`0`** | 정확히 `0` (Zero Leak) | **PASS** |
| **미등록 요청 시 고아 스레드 생성 수** | **`0 건`** | **`0 건`** | DB 오염 `0건` | **PASS** |

> **프로덕션 라이브 헬스체크 (무부하 단일 GET 2회)**:
> - `GET https://my-server-mocha.vercel.app/v1/healthz` → `HTTP 200` (`"OK"`, 콜드 스타트 `1,538.74 ms`)
> - `GET https://my-server-mocha.vercel.app/v1/heartbeat` → `HTTP 200` (`{"status":"alive","node":"v24.22.2","region":"iad1","commitSha":"cb5f128"}`, 웜 응답 `309.27 ms`)

---

## 3. R2: 적대적 보안 감사 결과 및 즉시 패치 내역

### 3.1 금일(2026-11-17) 적발 즉시 패치한 방어선·동기화 취약점 (5건)

1. **[치명적] 마크다운 HAST 속성 화이트리스트 강제 — 호스트 DOM 클로버링(`id`/`name`), 전체화면 `style` 클릭재킹, `ping` 비콘, `srcSet` 우회 차단 (`tokki-widget/lib/components/MarkdownPreview.tsx`)**
   - **원인**: 위젯이 iframe/Shadow DOM 없이 호스트 페이지(`#cx-shell`)에 직접 마운트되는 구조에서 `rehype-raw` 및 `rehype-slug`가 생성하는 `id`/`name` 속성이 `window.<id>`·`document.<name>` 전역 객체를 오염(DOM Clobbering)시킬 수 있었고, 원시 `style="position:fixed;inset:0;z-index:2147483647;background:url(...)"`을 통한 호스트 전체화면 클릭재킹·CSS 유출, `<a ping="...">` 은닉 POST 비콘, `<img srcset="//evil.com/...">` 배열 속성 우회가 가능했다.
   - **패치**: 블랙리스트 방식을 폐기하고 엄격한 `SAFE_HAST_PROPS` 화이트리스트를 도입하여 `id`, `name`, `style`, `ping`, `srcSet`/`srcset`, `on*` 등을 일괄 제거하되 코드 하이라이팅·복사 기능(`className`, `data-code`, `data-line`)은 완벽히 보존하고 `<img src>`에 `sanitizeImageUrl()`을 강제했다.
2. **WHATWG 백슬래시(`/\evil.com`)·제어문자(`/\t/evil.com`) URL 리다이렉트 우회 차단 및 이미지 `src` 전역 정화 (`tokki-widget/lib/utils/sanitize-url.ts`, `ChatToggle.tsx`, `ChatWindow.tsx`, `ChatMessage.tsx`)**
   - **원인**: 브라우저 WHATWG URL 파서는 `/\evil.example.com` 및 `/\t/evil.example.com`을 외부 도메인 `https://evil.example.com`으로 해석하나 기존 `startsWith("//")` 검사만으로는 이를 걸러내지 못했고, 런처 아이콘(`customIconUrl`)·프로필 아바타(`assistantProfileImageUrl`, `profileImageUrl`)의 `<img src>`에 스킴 검증이 없었다.
   - **패치**: 모든 상대 경로를 `new URL(trimmed, "https://relative.tokki.local")`로 해석해 동일 오리진 유지 여부를 수학적으로 검증하고 제어문자·자격증명 포함 URL을 차단했으며, SVG 데이터 URI(`data:image/svg+xml`) 및 `javascript:`를 원천 차단하는 `sanitizeImageUrl()`을 모든 이미지 렌더링 지점에 적용했다.
3. **프런트엔드 `startQuestion` / `startVoiceQuestion` 및 추천 질문 칩 동일 프레임 재진입(Re-entrancy) 잠금 보강 (`tokki-widget/lib/state/chat.tsx`, `ChatWindow.tsx`)**
   - **원인**: Valtio `useSnapshot`은 React 비동기 리렌더링 전까지 이전 스냅샷을 유지하므로, 추천 질문 칩을 빠르게 더블클릭하거나 `chatOps.startQuestion()`을 직접 호출할 경우 중복 `/v2/ask` 스트림이 동시에 열려 `streamResponseText`가 뒤섞일 수 있었다.
   - **패치**: `startQuestion()`과 `startVoiceQuestion()` 최상단에 실시간 프록시 기반 `if (chatState.waitingResponse) return` 동기 가드를 추가하고, `ChatWindow.tsx` 추천 질문 클릭 핸들러에서도 `chatOps.isBusy()`를 즉시 확인하도록 수정했다.
4. **백엔드 `icon_url` 프로토콜 상대(`//evil.com`)·백슬래시(`/\evil.com`)·빈 호스트 검증 우회 차단 (`my-server-test/lib/url-guard.ts`, `lib/widget-store.ts`, `src/endpoints/v2/widget-endpoints.ts`)**
   - **원인**: 기존 정규식 `/^(?:https?:\/\/|\/).../`이 `//evil.attacker.com/p.svg`와 `/\evil.attacker.com/p.svg`를 유효한 상대 경로 `/`로 오인하여 통과시켰다.
   - **패치**: 전용 순수 검증 모듈 `lib/url-guard.ts`(`isValidWidgetIconUrl`)를 신설해 프로토콜 상대 URL, 백슬래시, 제어문자, 자격증명 포함 URL, 호스트명 없는 URL을 `HTTP 400`으로 즉시 차단했다.
5. **Upstash Redis L1/L2 `mirrorReservation` 동기화, 업스트림 `HTTP 408` 페일오버 회전 및 `syncKeys` 복원력 패치 (`my-server-test/lib/llm/key-manager/stores/memory.ts`, `upstash-redis.ts`, `executor.ts`, `lib/llm/rotating-provider.ts`)**
   - **원인**: `UpstashRedisKeyStore.reserveKey()` 성공 시 L1 `MemoryKeyStore`에 리스·카나리아 토큰이 미러링되지 않아 쿨다운 경과 후 `acknowledgeHandshake()` 졸업이 L1에 반영되지 않고 `getAllStates()`가 영구히 `RATE_LIMITED`로 남는 불일치가 있었으며, 업스트림 `HTTP 408` 타임아웃이 키 회전 없이 `502`로 실패하고 `ensureSynced()` 최초 실패 시 거부된 Promise가 캐싱되는 문제가 있었다.
   - **패치**: `MemoryKeyStore.mirrorReservation()`을 추가해 Redis 예약 즉시 L1 상태를 동기화하고, `executor.ts`에서 `HTTP 408` 발생 시 즉시 다음 정상 키로 페일오버하도록 수정했으며, `ensureSynced()` 실패 시 `this.syncPromise = null`로 초기화해 자동 복구되도록 보강했다.

### 3.2 실시간 `curl` 적대적 보안 경계 검증 로그 (18개 공격·경계 벡터 전량 통과)

| 벡터 ID | 실측 공격·경계 시나리오 (`/usr/bin/curl`) | 기대 상태 | 실측 상태 | 응답 본문 요약 | 소요 시간 | 판정 |
| :---: | :--- | :---: | :---: | :--- | :---: | :---: |
| `V01` | `POST /v2/ask` — `widgetId` 필드 누락 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `10.31 ms` | **PASS** |
| `V02` | `POST /v2/ask` — 미등록 `widgetId` 변조 (`"evil-spoof-widget-999"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `7.43 ms` | **PASS** |
| `V03` | `POST /v2/ask` — SQL 인젝션 `widgetId` (`"' OR '1'='1"`) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.79 ms` | **PASS** |
| `V04` | `POST /v2/ask` — 초장문 `widgetId` (500자, DB 무조회 즉시 거부) | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}` | `6.39 ms` | **PASS** |
| `V05` | `POST /v2/widget/create-thread` — 미등록 `widgetId` 스레드 발급 시도 | `403` | **`403`** | `{"success":false,"error":"unregistered widget_id"}` | `7.31 ms` | **PASS** |
| `V06` | `POST /v2/ask` — 정상 최대 경계값 `message` 정확히 `4,000자` | `200` | **`200`** | `data: 토키%20 ... data: [DONE]` (정상 SSE 스트리밍) | `71.15 ms` | **PASS** |
| `V07` | `POST /v2/ask` — 경계 초과 `message` `4,001자` | `413` | **`413`** | `{"success":false,"error":"message too long (4001 > 4000 chars)"}` | `7.64 ms` | **PASS** |
| `V08` | `POST /v2/ask` — `50,000자` 한글 토큰 폭탄 (Token Bomb) | `413` | **`413`** | `{"success":false,"error":"message too long (50000 > 4000 chars)"}` | `7.29 ms` | **PASS** |
| `V09` | `POST /v2/ask` — `browserInfo` 보조 필드 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"browserInfo too large (2509 > 2000 chars)"}` | `6.42 ms` | **PASS** |
| `V10` | `POST /v2/ask` — `threadId` 비문자열 중첩 객체 밀수 (`2,500자`) | `413` | **`413`** | `{"success":false,"error":"threadId too large (2513 > 2000 chars)"}` | `5.70 ms` | **PASS** |
| `V11` | `POST /v2/ask` — Chunked + 대문자/OWS `APPLICATION/JSON ; charset=utf-8` 1.15MB 바디 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `7.27 ms` | **PASS** |
| `V12` | `POST /v2/ask` — `Content-Length > 1MB` (1.15MB 바디 헤더 선차단) | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}` | `5.85 ms` | **PASS** |
| `V13` | `POST /v2/ask` — 상충 복수 `Content-Length: 10, 2097152` 스머글링 차단 (RFC 9112 §6.3) | `400` / `413` | **`400`** | 소켓 HTTP 파서 계층 `400` 즉시 차단 + 프록시 정규화 시 `onRequest` `413` 이중 방어 | `5.02 ms` | **PASS** |
| `V14` | `POST /v2/admin/widgets/upload-icon` — Chunked `2.35MB` 멀티파트 스트림 차단 | `413` | **`413`** | `{"success":false,"error":"Payload Too Large: request body exceeds 2MB limit"}` | `8.01 ms` | **PASS** |
| `V15` | `POST /v2/admin/widgets/upsert` — 프로토콜 상대 `icon_url` (`"//evil.attacker.com/p.svg"`) 차단 (신규 패치) | `400` | **`400`** | `{"success":false,"error":"invalid icon_url (must be http(s):// or relative / path)"}` | `6.67 ms` | **PASS** |
| `V16` | `POST /v2/admin/widgets/upsert` — 백슬래시 스머글링 `icon_url` (`"/\\evil.attacker.com/p.svg"`) 차단 (신규 패치) | `400` | **`400`** | `{"success":false,"error":"invalid icon_url (must be http(s):// or relative / path)"}` | `5.22 ms` | **PASS** |
| `V17` | `POST /v2/widget/view` — `widgetId: null, threadId: null` 고아 스레드 무생성 검증 | `200` | **`200`** | `{"success":true,"thread_id":"",...}` (DB 고아 스레드 생성 `0건`) | `5.69 ms` | **PASS** |
| `V18` | `POST /v2/ask` — 동일 IP 분당 10회 초과 폭주 방어 (11번째 요청) | `429` | **`429`** | `{"success":false,"error":"Too Many Requests",...,"retryAfter":60}` | `4.77 ms` | **PASS** |

---

## 4. R3: 자동화 무결성 검증 및 프리플라이트 빌드 결과

### 4.1 테스트 스위트 실행 결과 (`bun test`)

| 저장소 | 테스트 파일 수 | 통과 / 실패 | `expect()` 단언문 수 | 실행 시간 | 종료 코드 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`my-server-test` (백엔드)** | 13개 파일 | **`304 PASS / 0 FAIL`** | `1,925`개 | `4.52s` | `0` |
| **`tokki-widget` (프런트엔드)** | 2개 파일 | **`35 PASS / 0 FAIL`** | `162`개 | `0.20s` | `0` |
| **합계** | **15개 파일** | **`339 PASS / 0 FAIL` (100%)** | **`2,087`개** | **`4.72s`** | **`0`** |

### 4.2 로컬 프리플라이트 빌드 검증

- **백엔드 번들 동기화 (`my-server-test`)**:
  - `npm run bundle:api` → 7개 SQL 마이그레이션 인라인(`src/generated-migrations.ts`) 및 단일 서버리스 번들 `api/index.js` (`26.9MB`, Node 24 CJS) 빌드 성공 (`106ms`).
  - Node.js CJS 핸들러 스모크 검증 (`require("./api/index.js").default` → `GET /v1/healthz`) → `HTTP 200 OK` 정상 반환 확인.
- **프런트엔드 타입체크 및 프로덕션 번들 빌드 (`tokki-widget`)**:
  - `npm run type-check` (`tsc`) → 타입 오류 `0건`.
  - `npm run build` (라이브러리 빌드 + `.d.ts` 생성) → `dist/` 정상 생성 (`2.67s`).
  - `npm run build:embed` (임베드 단일 스크립트 빌드) → `dist-embed/tokki.js` 및 `public/embed/tokki.js` (`2,133.22 kB` / gzip `624.61 kB`) 동기화 완료 (`2.00s`).
  - `npm run export-playground` (플레이그라운드 번들 빌드) → `export-playground/main.js` 정상 생성 (`2.42s`).

---

## 5. 수락 기준(Acceptance Criteria) 최종 점검표

- [x] **[성능 및 방어 무결성]** 제어된 동시 요청(18건 + 12건) 및 HTTP 429/402 오류 주입 환경에서 교착 상태나 메모리·세마포어 누수(`ZCARD = 0`) 없이 **100% 페일오버**를 달성했는가? → **달성 완료 (`89.33 ms` / `86.57 ms`, 완주율 100%, 형제 파산 키 호출 `0건`, `ZCARD = 0`)**
- [x] **[보안 경계 입증]** 악의적 `widgetId` 변조(`HTTP 403`) 및 초대형 페이로드·토큰 폭탄 공격(`HTTP 413`) 차단이 실측 로그로 입증되었는가? → **18개 실전 `curl` 벡터 전량 통과(`18/18 PASS`) 및 5건의 심층 우회·동기화 취약점 즉시 패치 완료**
- [x] **[최종 산출물]** 한국어 감사 보고서(`stress_test_audit.md`)가 생성되었는가? → **양쪽 워크스페이스(`my-server-test`, `tokki-widget`)에 한국어로 생성 완료**
- [x] **[테스트 무결성]** 모든 방어 테스트(`bun test`)가 종료 코드 `0`으로 100% 통과했는가? → **`339 / 339 PASS` (`2,087` assertions, `Exit Code 0`)**
- [x] **[쿼터 보호]** 커밋 메시지에 `[skip ci]`가 포함되어 Vercel 및 GitHub Actions 무료 쿼터를 보호했는가? → **`fix(tokki): automated defense and load test patch [skip ci]` 로컬 커밋 적용 완료 (무료 배포 쿼터 보호를 위해 불필요한 원격 푸시 생략)**
