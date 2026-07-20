# AGENTS.md

이 파일은 **AI 코딩 에이전트**(Claude Code 등)가 이 저장소에서 작업할 때 먼저 읽어야 하는 안내서다. 사람용 README가 아니라, 에이전트가 헛수고 없이 바로 올바른 변경·배포를 하도록 돕는 운영 지침이다.

---

## 1. 이 프로젝트가 뭔가

**Elysia(TypeScript) 기반 REST API 서버**를, Bun이 아니라 **Vercel Node serverless function** 위에서 돌리는 프로젝트다.

- 프레임워크: [Elysia](https://elysiajs.com) — 원래 Bun-first지만, 여기서는 `app.handle(Request)` (Web Standards) 어댑터를 통해 Vercel Node 런타임에서 구동한다.
- 런타임: Vercel Serverless Function, **Node.js 20.x**.
- 데이터: Supabase(Postgres). 채팅 이력·위젯 마스터 저장.
- 용도: 두 가지 기능군이 한 서버에 있다.
  1. **YouTube OAuth + 댓글/답글/영상 관리 API** (`/v1/youtube/*`)
  2. **임베드형 채팅 위젯 백엔드** (`/v2/*`) — LLM 스트리밍 + 대화 이력 영속화

### 프로덕션 URL
- ✅ **정상 동작: `https://my-server-test.vercel.app/`**
- ⚠️ `https://my-server-pearl-eta.vercel.app/` 는 **옛 깨진 deploy에 핀된 alias** — 무시하거나 대시보드에서 정리할 것. 테스트는 항상 `my-server-test` 도메인으로.
- 루트 `/` 는 Swagger(Scalar) API 문서 UI.

---

## 2. ⚠️ 배포 아키텍처 — 가장 중요. 먼저 읽어라

이 저장소의 배포는 **일반적인 Vercel 프로젝트와 다르다.** 모르고 건드리면 전부 깨진다.

### 빌드/번들 흐름
```
lambda-src/handler.ts   ← 핸들러 소스 (Node IncomingMessage ↔ Web Request 어댑터)
        │  esbuild로 번들 (모든 src/·lib/ 의존성 inline)
        ▼
api/index.js            ← 단일 CJS 번들 (~27MB). git에 직접 커밋됨. Vercel은 이걸 함수로 인식.
```

- **`api/index.js`는 빌드 산출물이지만 git에 커밋한다.** Vercel이 함수를 빌드 *전* 시점에 `api/` 스캔으로 결정하기 때문에, buildCommand로 생성한 파일은 함수로 인식되지 않는다. 그래서 미리 번들해서 커밋하는 방식을 쓴다.
- **소스를 고쳤으면 반드시 재번들 후 `api/index.js`까지 같이 커밋**해야 프로덕션에 반영된다. (아래 4번 절차)
- `api/hello.js` 는 플랫폼 sanity check용 plain stub. Elysia와 무관. 지우지 말 것(디버깅 자산).

### `vercel.json` 핵심 (건드리기 전에 이유를 이해할 것)
```jsonc
{
  "framework": null,            // Vercel이 Next.js로 오인하지 않게 — 빼면 "No Next.js detected"로 빌드 실패
  "buildCommand": "echo skip",  // package.json의 "build": "tsc"가 자동 실행되면 lib/ 타입에러로 실패함 → 무력화
  "outputDirectory": "public",  // framework null이면 정적 output 디렉토리 필수 — 빈 public/.gitkeep 존재
  "rewrites": [{ "source": "/((?!api/).*)", "destination": "/api" }]  // /api/* 외 모든 경로를 Elysia 함수로
}
```

### 과거에 실제로 겪은 함정 (반복하지 말 것)
1. `package.json`의 `engines.node`는 **20.x 유지**. 18.x는 Vercel이 거부.
2. git commit author email이 GitHub 계정과 매칭 안 되면 **Vercel이 deploy 자체를 거부**한다(500/404가 안 바뀜). author 꼬이면 의심.
3. **`.ts` 파일은 Vercel 런타임이 직접 로드 못 한다.** dynamic import도 트레이서가 의존성을 못 끌어온다. → 반드시 esbuild 단일 번들.
4. **module-load 시점에 throw하는 코드 금지.** 예: `lib/supabase/client.ts`의 `supabaseClient`는 env 누락 시 cold start에서 함수 전체를 크래시(`FUNCTION_INVOCATION_FAILED`)시켰다. 지금은 **lazy Proxy**로 첫 사용 시점까지 생성을 미룬다. 새 전역 클라이언트를 만들 때 같은 패턴을 따를 것.

---

## 3. 디렉토리 지도

```
api/
  index.js              ← esbuild 번들 (커밋된 빌드 산출물). 직접 편집 금지 — lambda-src에서 생성됨.
  hello.js              ← 플랫폼 sanity stub. 건드리지 말 것.
lambda-src/
  handler.ts            ← serverless 진입점. Node req/res ↔ Web Request/Response 어댑터 + createApp 호출.
src/
  app.ts                ← Elysia 앱 조립: CORS, Swagger, v1/v2/healthz 엔드포인트 등록. ★엔드포인트 추가 시 여기 등록★
  index.ts              ← 로컬 dev 전용 (app.listen). serverless에선 안 씀.
  endpoints/
    healthz.ts          ← GET /v1/healthz (liveness "OK"), GET /v1/heartbeat (모니터링 JSON)
    v1/
      v1-endpoints.ts   ← v1 그룹. 현재 youtube만 등록됨.
      youtube/          ← YouTube OAuth + 댓글/답글/영상/채널 (활성)
      account/ widget/ billing/ chat/ ... ← 다수 존재하나 v1-endpoints.ts에 미등록 (비활성)
    v2/
      widget-endpoints.ts ← 위젯 백엔드 + admin (/v2/widget/*, /v2/ask, /v2/admin/*). requireAdmin 가드 포함.
      mail-endpoints.ts   ← /v2/admin/mail/send (네이버 SMTP). X-Admin-Token 인증.
lib/
  supabase/client.ts    ← lazy Proxy supabaseClient. ★module-load throw 금지 패턴의 본보기★
  llm/                  ← 멀티-벤더 LLM 추상화 (openrouter/openai/groq/...). /v2/ask가 사용.
  chat-store.ts         ← chat_thread / chat_message CRUD (Supabase)
  widget-store.ts       ← widget_master CRUD (per-widget 페르소나)
  sms/
    index.ts            ← SMS_PROVIDER 스위치로 3개 백엔드 통합 (phone/solapi/pushbullet)
    solapi.ts           ← SOLAPI SMS/카카오알림톡 (유료, 건당 과금). lazy-init 리팩터 완료(module-load throw 금지 패턴 적용)
    phone-gateway.ts    ← SMS Gate 안드로이드 게이트웨이 앱 API (APK 사이드로드 설치, 0원, 발송량 한도 없음)
    pushbullet.ts       ← Pushbullet API (Play스토어 정식 앱, 0원, 무료 계정 월 ~100건 한도)
  ⚠️ 자격증명 전부 env화 완료. 과거 SOLAPI 키 평문 노출 이력 있음 (7번 보안 주의 참고)
supabase/migrations/    ← SQL 마이그레이션 (chat_history, widget_master, thread_title)
vercel.json             ← 배포 설정 (2번 절 참고)
.env.example            ← 전체 env 변수 레퍼런스
```

---

## 4. 변경 → 배포 표준 절차 (이대로 따라라)

```bash
# 1. 소스 수정 (src/ 또는 lib/ 또는 lambda-src/)

# 2. 재번들 — esbuild로 api/index.js 재생성 (PATH 주의: nvm node 쓰면 esbuild 못 찾을 수 있음)
npx esbuild lambda-src/handler.ts --bundle --platform=node --target=node20 \
  --format=cjs --outfile=api/index.js --log-level=warning

# 3. (선택) 로컬 핸들러 검증
SUPABASE_URL=http://test SUPABASE_SERVICE_KEY=test node -e "
  const h = require('./api/index.js').default;
  const req = Object.assign(Object.create(require('http').IncomingMessage.prototype),
    { url:'/v1/healthz', method:'GET', headers:{host:'localhost'} });
  let b=''; const res={statusCode:0,headers:{},setHeader(){},write(c){b+=c},end(c){if(c)b+=c;console.log(this.statusCode,b.slice(0,80))}};
  h(req,res);"

# 4. 소스 + 번들을 함께 커밋 (api/index.js 빠뜨리면 프로덕션 반영 안 됨!)
git add <수정한 소스> api/index.js
git commit -m "..."
git push origin HEAD:main      # main에 push해야 Vercel production deploy 트리거됨

# 5. 배포 검증 (3~5분 후). my-server-test 도메인으로:
curl -s https://my-server-test.vercel.app/v1/healthz          # → OK
curl -s https://my-server-test.vercel.app/v1/heartbeat        # → {"status":"alive",...}
```

> **번들을 안 올리면 코드는 GitHub엔 있어도 프로덕션은 옛날 그대로다.** 가장 흔한 실수.

### 새 엔드포인트 추가할 때
1. `src/endpoints/...`에 핸들러 작성 (기존 youtube/widget 파일 패턴 따라 `app.post(...)`).
2. 그룹 인덱스(`v1-endpoints.ts` 또는 `widget-endpoints.ts`)나 `src/app.ts`에 **등록**. 등록 안 하면 404.
3. 4번 절차로 번들+커밋+푸시.

---

## 5. 엔드포인트 현황 (검증 완료 상태)

| 경로 | 메서드 | 동작 |
|---|---|---|
| `/` | GET | Swagger(Scalar) API 문서 UI |
| `/v1/healthz` | GET | liveness — `"OK"` 텍스트 |
| `/v1/heartbeat` | GET | 모니터링용 JSON (timestamp/uptime/region/commitSha) |
| `/v1/youtube/auth/create` | POST | Google OAuth 인증 URL 생성 (clientId/clientSecret/redirectUri 필요) |
| `/v1/youtube/auth/confirm` | GET | OAuth 콜백 → accessToken/refreshToken 교환 |
| `/v1/youtube/channel/info` | POST | 채널 정보 |
| `/v1/youtube/video/list` | POST | 영상 목록 |
| `/v1/youtube/comment/list` · `/comment` · `/comment/delete` | POST | 댓글 조회/작성/삭제 |
| `/v1/youtube/reply/list` · `/reply` | POST | 답글 조회/작성 |
| `/v2/widget/view` | POST | 위젯 설정 + 스레드 메시지 복원 |
| `/v2/widget/create-thread` | POST | 새 스레드 UUID 발급 |
| `/v2/ask` | POST | **SSE 스트리밍** LLM 응답 + 양쪽 turn 영속화 |
| `/v2/admin/widgets` · `/widgets/upsert` · `/widgets/delete` | POST | 위젯 마스터 CRUD 🔒 |
| `/v2/admin/widgets/upload-icon` | POST | 위젯 런처 아이콘 업로드 🔒 |
| `/v2/admin/threads` · `/threads/rename` · `/threads/update` · `/messages` | POST | 세션/메시지 조회·관리 (per-session prompt·reference text 포함) 🔒 |
| `/v2/admin/db/migrate` | POST | SQL 마이그레이션 실행 (self-serve runner) 🔒⚠️ |
| `/v2/admin/mail/send` | POST | 네이버 SMTP 메일 발송 🔒 (`X-Admin-Token`: `MAIL_SEND_TOKEN` 또는 `ADMIN_TOKEN`) |
| `/v2/admin/sms/send` | POST | SMS 발송 🔒 — `SMS_PROVIDER` env로 백엔드 선택(9번 절 참고). ⚠️ **소스엔 등록됐으나 `api/index.js` 미재번들 — 프로덕션 미배포 상태**(4번 절 표준 절차로 배포 전까지는 로컬(`bun run dev`)에서만 동작) |

🔒 = `x-admin-token` 헤더 필수 (7번 절 참고). 토큰 없거나 불일치 → `{success:false, error:"unauthorized"}`.

> 명절 인사 등 **일괄 SMS 발송은 이 HTTP 엔드포인트가 아니라 `scripts/send-greetings.ts`를 로컬에서 직접 실행**하는 게 정석 경로다(9번 절). Vercel 배포와 무관하게 동작한다.

**검증 시 기대 응답:** valid 입력 → 200, 입력 누락 → 422(Elysia validation), 미존재 경로 → 404, admin 토큰 누락 → `success:false`. `/v1/youtube/auth/confirm`은 에러 시 **400 + `{success:false, message}`** (200 schema와 분리하려고 `set.status=400` 명시함 — 빼면 422 validation wrapper로 깨짐).

---

## 6. 환경 변수

전체 목록은 `.env.example` 참조. 핵심만:

| 변수 | 용도 | 없으면 |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | 채팅/위젯 영속화 | lazy Proxy라 cold start는 살아있고, DB 닿는 핸들러에서 throw |
| `LLM_API_KEY` | `/v2/ask` 실제 LLM | 비어 있으면 canned 데모 응답으로 fallback |
| `LLM_PROVIDER` | openrouter(기본)/openai/groq/together/deepseek/mistral/fireworks/custom | openrouter |
| `LLM_MODEL`, `LLM_MAX_TOKENS`(기본512), `LLM_SYSTEM_PROMPT` | 선택 튜닝 | 기본값 |
| `ADMIN_TOKEN` | `/v2/admin/*` 인증 시크릿 | **미설정 시 모든 admin 요청 거부(fail-closed)** |
| `MAIL_SEND_TOKEN`, `NAVER_MAIL_USER`, `NAVER_MAIL_PASSWORD`, `NAVER_MAIL_FROM_NAME` | `/v2/admin/mail/send` 네이버 SMTP | 메일 발송 거부 |
| `SMS_PROVIDER` | SMS 백엔드 선택(`phone`/`solapi`/`pushbullet`) | 미설정 시 `phone` 기본값 |
| `PUSHBULLET_ACCESS_TOKEN`, `PUSHBULLET_DEVICE_IDEN` | `SMS_PROVIDER=pushbullet` | 발송 거부(`isSmsConfigured()`가 false) |
| `SMS_GATEWAY_URL/USERNAME/PASSWORD/SIM` | `SMS_PROVIDER=phone` (SMS Gate 앱) | 발송 거부 |
| `SOLAPI_API_KEY/SECRET/ADMIN_PHONE_NUMBER`, `KAKAO_BUSINESS_CHANNEL_ID` | `SMS_PROVIDER=solapi` (건당 과금) | 발송 거부 — 카카오 알림톡 전용 함수 호출 시에만 채널ID 필요 |

> Vercel 환경변수는 **대시보드 → Settings → Environment Variables**에서 설정. 추가 후 재배포 필요.

---

## 7. 보안 주의 (에이전트가 꼭 인지할 것)

1. **`/v2/admin/*` 는 `x-admin-token` 헤더 인증으로 보호된다.** `widget-endpoints.ts`의 `requireAdmin(headers)` 가드가 매 admin 핸들러 첫 줄에서 `process.env.ADMIN_TOKEN`과 대조한다. **fail-closed** — `ADMIN_TOKEN`이 서버에 없으면 모든 admin 요청을 거부한다. 새 admin 엔드포인트를 추가하면 **반드시 `requireAdmin` 호출을 첫 줄에 넣을 것.**
   - 메일 엔드포인트(`/v2/admin/mail/send`)는 `MAIL_SEND_TOKEN`(메일 전용) **또는** `ADMIN_TOKEN`(전체 admin) 중 하나와 일치하면 통과.
2. **`/v2/admin/db/migrate` 는 SQL 마이그레이션을 실행하는 위험 엔드포인트**다. `x-admin-token` 뒤에 있지만, 토큰이 유출되면 DB 조작이 가능하다. `ADMIN_TOKEN`은 강한 시크릿으로 유지하고 로그/커밋에 절대 남기지 말 것.
3. **`lib/sms/solapi.ts`의 Solapi 자격증명이 과거 평문 커밋되어 public GitHub에 노출된 이력**이 있다. 코드는 env로 분리했으나, **노출된 키는 솔라피 대시보드에서 폐기/재발급해야 한다**(아직 안 됐다면).
4. 새 비밀값을 코드에 하드코딩하지 말 것. 전부 `process.env`로.
5. **`PUSHBULLET_ACCESS_TOKEN`은 그 계정에 연결된 폰으로 SMS를 보낼 수 있는 권한을 통째로 준다** — `ADMIN_TOKEN`급으로 취급할 것. 로컬 `.env`에만 두고 로그/커밋 금지 (9번 절).

---

## 8. 빠른 체크리스트 (작업 시작 전)

- [ ] 소스 고쳤으면 `api/index.js` 재번들했나?
- [ ] 번들을 소스와 **함께** 커밋했나?
- [ ] `main`에 push했나? (production deploy 트리거)
- [ ] 새 엔드포인트면 `app.ts`/그룹 인덱스에 등록했나?
- [ ] module-load 시점에 throw하는 코드를 넣지 않았나? (lazy 패턴 유지)
- [ ] 검증은 `my-server-test.vercel.app` 도메인으로 했나?
- [ ] `vercel.json`의 4개 키(framework/buildCommand/outputDirectory/rewrites)를 이유 없이 바꾸지 않았나?

---

## 9. SMS 발송 (명절 인사 등 일괄 문자)

**배경:** 유료 SMS(SOLAPI 등)를 쓰지 않고 **0원으로** 문자를 보내고 싶다는 요구에서 시작. "공짜 + 쉬움 + APK 사이드로드 없음"을 동시에 만족하는 방법을 찾아 3가지 백엔드를 `lib/sms/index.ts`의 `SMS_PROVIDER` 스위치로 통합했다.

### 백엔드 3종 비교

| `SMS_PROVIDER` | 방식 | 비용 | 설치 | 한도 |
|---|---|---|---|---|
| `pushbullet` | Play스토어 정식 앱(Pushbullet)이 본인 폰으로 발송 | 0원(문자무제한 요금제 전제) | 앱 설치만, APK 사이드로드 없음 | **무료 계정 월 ~100건** |
| `phone` (기본값) | SMS Gate 앱(APK)이 안드로이드 공기계로 발송 | 0원 | GitHub Releases APK 사이드로드 필요 | 없음 |
| `solapi` | SOLAPI(구 CoolSMS) 유료 API | 건당 과금(SMS ~13원) | 없음(API 키만) | 과금 기반이라 사실상 없음 |

세 백엔드 모두 **import 시점에 절대 throw하지 않는다**(4번 항목의 lazy 패턴 준수) — `isSmsConfigured()`로 설정 여부만 확인하고, 실제 미설정 시 에러는 발송 함수 호출 시점에만 던진다.

### 실사용 경로: `scripts/send-greetings.ts` (로컬 실행, HTTP 엔드포인트 아님)

```bash
cp scripts/contacts.example.csv contacts.csv   # name,phone — git에 안 잡힘(PII, .gitignore 처리됨)
cp scripts/greeting.example.txt greeting.txt   # {name}/{이름} 치환됨

node --env-file=.env scripts/send-greetings.ts --csv contacts.csv --template greeting.txt          # 미리보기(기본, 발송 안 함)
node --env-file=.env scripts/send-greetings.ts --csv contacts.csv --template greeting.txt --send   # 실제 발송
```

- **`--send` 없으면 무조건 미리보기만** — 실수로 100명에게 오발송하는 사고 방지용 안전장치. 절대 이 기본값을 바꾸지 말 것.
- `SMS_SEND_DELAY_MS`(기본 2000ms)로 발송 간 딜레이 — 통신사 스팸필터 회피용. 낮추지 말 것.
- **발송량 카운터**: `lib/sms/usage.ts`가 월별·provider별 성공 건수를 `.sms-usage.json`(로컬, gitignore, 전화번호 미저장)에 누적. send-greetings.ts가 발송 전 `사용/한도 → 예상`을 출력하고 성공마다 기록한다. pushbullet은 `PUSHBULLET_FREE_LIMIT`(기본 100) 초과 예상 시 **경고만**(차단 안 함). `npm run sms:usage`로 이번 달 사용량 조회. ⚠️ 이 맥에서 보낸 것만 집계(로컬 추정), 월 경계는 달력월 근사 → 90건쯤 여유 권장.
- 이 스크립트는 `lib/sms/phone-gateway.ts`·`lib/sms/pushbullet.ts`를 **`.ts` 확장자 포함 직접 import**한다(barrel `lib/sms/index.ts`를 쓰지 않음) — `node --env-file`의 네이티브 ESM 리졸버가 확장자 생략·barrel의 extensionless 서브 import를 못 풀기 때문. 이 스크립트를 고칠 때 barrel import로 "정리"하지 말 것 — 조용히 깨진다.

### `/v2/admin/sms/send` (HTTP 엔드포인트)

Vercel에 올리려면 4번 절 표준 절차(재번들+커밋)가 별도로 필요하다 — **현재 미배포 상태**(위 5번 절 표 참고). 일괄 발송 용도로는 쓸 일이 없고(위 로컬 스크립트가 정석), 외부 시스템에서 SMS를 트리거해야 하는 시나리오가 생기면 그때 배포할 것.

### 검증된 사실 (재조사 불필요)

- Pushbullet 무료 한도 월 100건은 **공식 블로그**(blog.pushbullet.com, 2020) 원문 확인: "Pro is required to send more than 100 messages per month" — 100건까지는 무료 계정으로 API 발송 가능.
- SMS Gate(`sms-gate.app`)는 Play스토어/F-Droid 미등재, GitHub Releases APK가 유일한 정식 설치 경로. Play스토어의 동명 "SMS Gateway" 계열 앱들은 전부 무관한 별개 앱(사칭 아님, 그냥 다른 제품).
- 무료문자 웹사이트(문자나라/문자라인 등), 네이버클라우드 SENS 무료크레딧(3개월 한정+카드등록), Termux Play스토어판(SMS 명령 없음), U+ 웹문자(기업용 유료) — 전부 이 프로젝트 용도(100명 개인화 일괄발송)엔 부적합함을 확인 후 기각.
