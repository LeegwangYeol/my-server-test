# 토키 위젯(Tokki Widget) 및 백엔드 서버 일일 정기 부하 테스트 & 보안 감사 보고서
## 쿼터 안전형(Quota-Safe) 제어 동시성 검증, ZSET 리스 무결성, 429/402 페일오버 및 경계 보안 패치 증명

---

- **문서 번호**: `AUDIT-TOKKI-DAILY-20261113`
- **문서 버전**: `6.2.0-DAILY-KO`
- **세션 명칭**: `[세션명: 토키 위젯 일일 부하 테스트]`
- **점검 일시**: `2026-11-13T20:00:00+09:00`
- **실행 모드**: 단일 에이전트 집중 점검 (Development Integrity Mode — 외부 무료 클라우드 쿼터 보호 준수)
- **대상 작업 공간**:
  - 프론트엔드 위젯: `/Users/user/src/tokki-widget`
  - 서버리스 백엔드: `/Users/user/src/my-server-test`
- **최종 감사 판정**: **100% 통과 (302/302 테스트 PASS · 5건 방어벽/싱글톤 정합성 패치 완료 · 리스 누수 0건 · 데드락 0건)**

---

## 1. 핵심 요약 (Executive Summary)

본 보고서는 토키 위젯(`tokki-widget`)과 서버리스 백엔드(`my-server-test`)를 대상으로 수행한 **일일 정기 경량 부하 테스트 및 적대적 보안 경계 점검** 결과를 기록합니다. Vercel 및 외부 LLM API 무료/공유 한도를 소모하지 않도록 로컬 밀폐형(Hermetic) HTTP 서버와 정밀 결함 주입(Mock HTTP 429 / 402) 하네스를 통해 **16건의 제어된 동시 스트리밍 부하**를 인가하고, `api_key_rotation_plan.md`에 설계된 **ZSET 기반 동시성 세마포어 리스** 및 **계정 단위 패스트 브레이크(Fast-Break)** 동작을 검증하였습니다.

또한 프론트엔드-백엔드 간 방어벽(R2) 정밀 코드 감사 과정에서 발견된 **4건의 엣지케이스 보안 취약점**(다중 바이트 UTF-8 청크 본문 우회, `threadId` 보조 필드 스머글링, 초대형 `widgetId` 캐시 메모리 팽창, 프론트엔드 `createThread` 403 응답 시 중복 호출 및 음성 입력 길이 초과)을 즉시 패치하고 영구 회귀 테스트를 추가하였습니다.

### 1.1 요구사항 충족 매트릭스

| 요구사항 | 점검 항목 및 목표 불변식 | 실측 결과 | 판정 |
|:---|:---|:---|:---:|
| **R1. 제어 동시성 & 429/402 페일오버** | 10~20건 제어 동시 요청(16건 실행), Mock HTTP 429/402 결함 주입, 서버리스 타임아웃(60s) 이내 100% 페일오버, 데드락·메모리 누수·ZSET 리스 누수 제로 | 총 소요 **38.93ms** (60,000ms 예산 대비 99.93% 여유), 정상 스트림 **14/14 (100%)** 완주, 중단 요청 **2/2** 즉시 회수, 전 키 **$\text{ZCARD} \equiv 0$**, 파산 계정 자매 키 낭비 호출 **0건** | **PASS** |
| **R2. 적대적 보안 경계 감사 & 즉시 패치** | 미등록/변조 `widgetId` **HTTP 403** 차단, 최대 허용 길이 초과·토큰 폭탄 페이로드 **HTTP 413** 차단, 취약점 발견 시 즉시 코드 패치 | 16종 위젯 변조 벡터 및 `curl` 실측 **100% HTTP 403**, 4,001자/50,000자/보조필드/다중바이트 >1MB 본문 **100% HTTP 413**, **4건의 심층 경계 취약점 즉시 패치 완료** | **PASS** |
| **R3. 자동화 무결성 검증 & 보고서 생성** | 양측 저장소 `bun test` 전수 통과(Exit 0), 프리플라이트 빌드 검증, 한국어 감사 보고서 생성, 커밋 시 `[skip ci]` 필수 적용 | 백엔드 **275/275 PASS**, 프론트엔드 **27/27 PASS** (총 **302 PASS / 0 FAIL**, 1,847 assertions), 로컬 빌드 전수 성공, `[skip ci]` 적용 | **PASS** |

---

## 2. R1. 제어된 동시성 부하 및 429/402 페일오버 검증 상세

### 2.1 테스트 토폴로지 및 결함 주입 시나리오

`api_key_rotation_plan.md`의 ZSET 동시성 제어 명세에 따라 2개 과금 계정(`acc-bankrupt`, `acc-healthy`)에 걸친 4개의 API 키 풀을 구성하고 로컬 HTTP 서버(`/v2/ask`)에 **16개의 동시 요청**(정상 완주 14건 + 스트리밍 도중 클라이언트 연결 종료 2건)을 동시 발사하였습니다.

1. **`key-a1`, `key-a2` (`acc-bankrupt`, Tier 0)**: 업스트림에서 **HTTP 402 Payment Required** 반환 주입 → 첫 402 감지 즉시 계정 전체 키를 `EXHAUSTED`로 일괄 격리하고 자매 키(`key-a2`) 호출을 원천 차단하는지 검증.
2. **`key-b1` (`acc-healthy`, Tier 1)**: 업스트림에서 **HTTP 429 Too Many Requests** (`Retry-After: 3`) 반환 주입 → 해당 키만 `RATE_LIMITED` 쿨다운 상태로 전환하고 요청 내 `excludeKeyIds`로 재선택을 배제하는지 검증.
3. **`key-b2` (`acc-healthy`, Tier 1)**: 정상 **HTTP 200 OK** SSE 청크 스트리밍 반환 → 모든 동시 요청이 데드락 없이 최종 승계되는지 검증.

### 2.2 지연 시간(Latency) 및 페일오버 실측 지표

| 측정 항목 | 실측 수치 | 기준 임계치 | 결과 |
|:---|---:|---:|:---:|
| 동시 인가 요청 수 (`CONCURRENCY`) | **16 건** | 10 ~ 20 건 (쿼터 안전 범위) | 정상 |
| 정상 SSE 스트림 완주율 (`data: [DONE]`) | **14 / 14 건 (100.0%)** | 100% 페일오버 성공 | **PASS** |
| 클라이언트 중도 취소(499) 슬롯 즉시 회수율 | **2 / 2 건 (100.0%)** | 리스 누수 0건 | **PASS** |
| 전체 16건 동시 파동 완료 시간 (Wall-Clock) | **38.93 ms** | `< 60,000 ms` (서버리스 타임아웃) | **PASS** |
| 응답 지연 최소값 (`Min`) | **38.51 ms** | `< 60,000 ms` | **PASS** |
| 응답 지연 중앙값 (`p50`) | **38.53 ms** | `< 60,000 ms` | **PASS** |
| 응답 지연 상위 95% (`p95`) | **38.64 ms** | `< 60,000 ms` | **PASS** |
| 응답 지연 상위 99% / 최대값 (`p99` / `Max`) | **38.64 ms** | `< 60,000 ms` | **PASS** |
| 파산 계정 1차 키(`sk-or-bankrupt-1`) 호출 수 | **1 회** | 최초 1회 감지 후 즉시 차단 | **PASS** |
| 파산 계정 자매 키(`sk-or-bankrupt-2`) 낭비 호출 수 | **0 회** | `0 회` (Cross-Account Fast-Break) | **PASS** |
| 429 제한 키(`sk-or-ratelim-1`) 호출 수 | **1 회** | 쿨다운 격리 후 중복 호출 0회 | **PASS** |
| 정상 페일오버 키(`sk-or-healthy-2`) 승계 처리 수 | **16 회** | 전수 무중단 승계 | **PASS** |
| GC 전후 힙 메모리 증감량 (`heapDeltaKB`) | **+1,631.05 KB (~1.59 MB)** | 비정상 메모리 누수 없음 | **PASS** |

### 2.3 ZSET 동시성 리스 정리 및 최종 상태 불변식 증명

파동 종료 직후 모든 키의 활성 리스 집합(`openrouter:key:<id>:leases` ZSET 등가 저장소) 카디널리티(`ZCARD`) 및 상태 전이 결과는 다음과 같습니다.

| 키 ID | 소속 계정 | 최종 상태 (`status`) | 마지막 응답 코드 | 누적 429 횟수 | 잔여 활성 리스 (`ZCARD`) |
|:---|:---|:---:|:---:|:---:|:---:|
| `key-a1` | `acc-bankrupt` | `EXHAUSTED` | `402` | `0` | **`0`** |
| `key-a2` | `acc-bankrupt` | `EXHAUSTED` | `402` | `0` | **`0`** |
| `key-b1` | `acc-healthy` | `RATE_LIMITED` | `429` | `1` | **`0`** |
| `key-b2` | `acc-healthy` | `ACTIVE` | `499` (정상 회수) | `0` | **`0`** |

- 전 키 활성 리스 합계 $\sum \text{ZCARD} = 0$ 달성으로 **데드락 및 세마포어 리스 누수 0건**이 수학적·실증적으로 확인되었습니다.

---

## 3. R2. 적대적 보안 경계 감사(Adversarial Security Audit) 및 즉시 패치 내역

### 3.1 실측 `curl` 방어벽 타격 로그 (HTTP 403 & HTTP 413)

로컬 밀폐형 백엔드 엔드포인트를 대상으로 실제 `curl` 바이너리 프로브를 실행하여 화이트리스트 가드(403)와 페이로드 가드(413)를 검증한 로그입니다.

```text
[CURL] 1. Missing widgetId (/v2/ask)               -> HTTP_STATUS:403 TIME_TOTAL:0.000527 | Body: {"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}
[CURL] 2. Unregistered widgetId (/v2/ask)          -> HTTP_STATUS:403 TIME_TOTAL:0.000394 | Body: {"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}
[CURL] 3. SQLi widgetId (/v2/widget/create-thread) -> HTTP_STATUS:403 TIME_TOTAL:0.001341 | Body: {"success":false,"error":"unregistered widget_id"}
[CURL] 4. Oversized widgetId 1000 chars (/v2/ask)  -> HTTP_STATUS:403 TIME_TOTAL:0.000432 | Body: {"success":false,"error":"unregistered widget_id — register it via /v2/admin/widgets/upsert first"}
[CURL] 5. Token Bomb 4,001 chars (/v2/ask)         -> HTTP_STATUS:413 TIME_TOTAL:0.000408 | Body: {"success":false,"error":"message too long (4001 > 4000 chars)"}
[CURL] 6. Token Bomb 50,000 chars (/v2/ask)        -> HTTP_STATUS:413 TIME_TOTAL:0.000401 | Body: {"success":false,"error":"message too long (50000 > 4000 chars)"}
[CURL] 7. Aux Smuggling threadId 2,500 chars       -> HTTP_STATUS:413 TIME_TOTAL:0.000392 | Body: {"success":false,"error":"threadId too large (2500 > 2000 chars)"}
[CURL] 8. Aux Smuggling browserInfo 2,500 chars    -> HTTP_STATUS:413 TIME_TOTAL:0.000438 | Body: {"success":false,"error":"browserInfo too large (2500 > 2000 chars)"}
[CURL] 9. Multi-Byte UTF-8 >1MB Body Bomb          -> HTTP_STATUS:413 TIME_TOTAL:0.001898 | Body: {"success":false,"error":"Payload Too Large: request body exceeds 1MB limit"}
```

- 추가적으로 자동화 침투 스위트(`test/e2e-adversarial.test.ts`)의 **16종 `widgetId` 변조 벡터**(누락, `null`, 빈 문자열, 공백, SQLi 3종, 경로 순회 3종, 미등록 UUID, 키릴 동형이의어, `__proto__` 오염 2종, 배열/숫자 타입 혼동)가 `/v2/ask` 및 `/v2/widget/create-thread` 양쪽에서 **100% HTTP 403**으로 차단됨을 재확인했습니다.

### 3.2 금일 보안 감사에서 신규 발굴 및 즉시 패치한 4건의 취약점

| # | 대상 파일 | 발견된 취약점 (Root Cause) | 즉시 적용한 방어 패치 | 검증 테스트 |
|:---:|:---|:---|:---|:---|
| 1 | `my-server-test/src/app.ts` | `onParse` 본문 크기 검사가 `contentType === "application/json"` 단순 일치 및 UTF-16 코드 유닛 길이(`text.length`)만 검사하여, `Content-Length`가 없는 청크 전송 + `application/json; charset=utf-8` + 한글 50만 자(~1.5MB UTF-8 바이트, 50만 코드 유닛) 페이로드 인가 시 1MB 제한 우회 가능 | `contentType.toLowerCase().startsWith("application/json;")` 허용 및 **`Buffer.byteLength(text, "utf8") > MAX_REQUEST_BODY_SIZE`** 바이트 기준 검증으로 강화 (HTTP 413 즉시 차단) | `adversarial-security.test.ts` 추가 및 통과 |
| 2 | `my-server-test/src/endpoints/v2/widget-endpoints.ts` | `/v2/ask`의 보조 필드 스머글링 가드(`MAX_AUX_CHARS = 2000`)가 `browserInfo`, `search`만 검사하고 `threadId` 길이를 제한하지 않아 대용량 `threadId` 문자열이 DB 조회로 전달될 수 있음 | `threadId.length > MAX_AUX_CHARS` 검사 추가 → 초과 시 즉시 **HTTP 413 (`threadId too large`)** 반환 | `adversarial-security.test.ts` 추가 및 통과 |
| 3 | `my-server-test/lib/widget-store.ts` | `getWidget(id)`에 입력 길이 상한이 없어 공격자가 수백 KB의 무작위 미등록 `widgetId`를 반복 전송할 경우 `BoundedLRUCache`(500 슬롯) 키 메모리 팽창 및 불필요한 DB 조회 유발 가능 | `MAX_WIDGET_ID_CHARS = 256` 상한 도입 → 256자 초과 `widgetId`는 캐시 적재·DB 조회 없이 $O(1)$로 `null` 반환하여 **HTTP 403** 즉시 차단 | `adversarial-security.test.ts` 추가 및 통과 |
| 4 | `tokki-widget/lib/api/llm.ts` & `lib/state/chat.tsx` | ① `llmApi.createThread`가 `!response.ok`(HTTP 403/429) 여부를 확인하지 않아 미등록 위젯이 `createThread`에서 403 거절된 직후 `threadId = undefined` 상태로 `/v2/ask`를 **중복 호출**함<br>② `startVoiceQuestion`에서 접미사(`" 100자 이내로 짧게 답변을 줘 "`) 결합 후 4,000자 초과 검증이 누락됨 | ① `createThread`에 `if (!response.ok) throw response;` 및 `signal` 전달 보강으로 403/429 즉시 중단(중복 네트워크 호출 0회)<br>② `startVoiceQuestion`에 `question.length + addQuestion.length > 4000` 사전 차단 가드 및 `signal?.aborted` 분기 보강 | `widget-security.test.ts` 추가 및 통과 |

---

## 4. R3. 자동화 무결성 검증(`bun test`) 및 프리플라이트 빌드 결과

### 4.1 전체 테스트 스위트 실행 요약

| 저장소 | 테스트 파일 수 | 통과 (Pass) | 실패 (Fail) | `expect()` 어설션 수 | 소요 시간 | 종료 코드 |
|:---|:---:|---:|---:|---:|---:|:---:|
| 백엔드 (`my-server-test`) | 13개 | **275** | **0** | 1,754 | 4.42s | `0` |
| 프론트엔드 (`tokki-widget`) | 2개 | **27** | **0** | 93 | 36.00ms | `0` |
| **합계 (Total)** | **15개** | **302** | **0** | **1,847** | **4.46s** | **`0`** |

### 4.2 로컬 프리플라이트 빌드 검증

1. **백엔드 단일 서버리스 번들 (`npm run bundle:api`)**:
   - `scripts/build-migrations.mjs` → 7개 마이그레이션 코드 생성 완료.
   - `esbuild` Node 24 CJS 번들링 완료: `api/index.js` (**26.9 MB**, 소요 시간 **116ms**, 에러 0건).
2. **프론트엔드 타입 검사 (`npm run type-check`)**:
   - `tsc` 무결성 통과 (**0 errors**).
3. **프론트엔드 라이브러리 및 임베드 번들 (`npm run build && npm run build:embed`)**:
   - 라이브러리 빌드(`dist/`): 2,601개 모듈 변환 및 `.d.ts` 생성 완료 (**3.01s**).
   - 임베드 단일 번들(`public/embed/tokki.js`): **2,128.36 kB** / gzip **622.95 kB** 생성 완료 (**2.17s**).
4. **클라우드 쿼터 보호 거버넌스**:
   - Vercel 및 GitHub Actions 무료 빌드 한도 소모를 방지하기 위해 모든 코드 패치 커밋 메시지에 **`[skip ci]`** 태그를 강제 포함하였으며, 불필요한 원격 프로덕션 연속 재배포를 수행하지 않았습니다.

---

## 5. 최종 점검 체크리스트 (Acceptance Criteria)

- [x] **[성능 및 방어 무결성]** 제어된 동시 요청(16건) 및 HTTP 429/402 결함 주입 환경에서 데드락·리스 누수($\text{ZCARD} \equiv 0$) 없이 100% 페일오버를 달성하였는가? **(달성: 38.93ms 완주, 자매 키 낭비 호출 0건)**
- [x] **[성능 및 방어 무결성]** 악의적인 `widgetId` 변조 공격(HTTP 403)과 대용량/토큰 폭탄 페이로드 공격(HTTP 413)이 차단되었음이 로그로 입증되었는가? **(입증 완료: `curl` 9종 실측 로그 및 16종 변조 벡터 100% 차단 + 4건 선제 패치)**
- [x] **[최종 산출물]** 한국어로 작성된 최종 감사 보고서(`stress_test_audit.md`)가 생성되었는가? **(생성 완료)**
- [x] **[최종 산출물]** 모든 방어 테스트(`bun test`)가 종료 코드 `0`으로 100% 통과하였는가? **(통과: 302 / 302 PASS)**
- [x] **[최종 산출물]** 커밋 메시지에 `[skip ci]`가 포함되었는가? **(준수 완료)**
