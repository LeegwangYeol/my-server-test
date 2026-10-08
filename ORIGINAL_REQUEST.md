# Original User Request

## Initial Request — 2026-09-15T09:43:43Z

This project is an Elysia-based REST API running on Vercel Node serverless, serving YouTube OAuth/API and an LLM chat widget backend. We need to evolve the project by automating the error-prone manual build/deploy process, adding robust security (rate limiting), and establishing comprehensive test coverage. Use a very large team of agents.

Working directory: /Users/user/src/my-server-test
Integrity mode: development

## Requirements

### R1. CI/CD Pipeline Automation
Implement a GitHub Actions workflow that automatically runs `npx esbuild` for `lambda-src/handler.ts`, generates `api/index.js`, and verifies that the bundle matches the committed version, or automates the deployment process to prevent the "forgot to bundle" issue described in AGENTS.md.

### R2. Rate Limiting
Implement a rate-limiting middleware for the `/v2/ask` (LLM streaming) and `/v1/youtube/*` endpoints to prevent abuse. Since it's serverless, consider a lightweight approach or clearly document the required infrastructure (e.g., Vercel KV or Upstash).

### R3. E2E and Integration Testing
Develop an automated test suite (e.g., using Bun test or Jest) to verify the core endpoints (`/v1/healthz`, `/v1/youtube/auth/create`, `/v2/ask` dummy responses) without hitting live external APIs (mocking Supabase and LLM providers).

## Acceptance Criteria

### CI/CD
- [ ] A `.github/workflows/ci.yml` file exists and correctly runs the esbuild command.
- [ ] The workflow includes a step to check if `api/index.js` is outdated compared to source files, failing the build if it is.

### Security
- [ ] Rate limiting logic is added to `app.ts` or endpoint files.
- [ ] Exceeding the rate limit returns an HTTP 429 status code.

### Testing
- [ ] A test suite can be run locally via a single `npm run test` or `bun test` command.
- [ ] Tests execute successfully without requiring actual Supabase credentials or LLM API keys.

## 2026-10-07T02:24:10Z

/teamwork-preview
/goal

> [절대 지령] 에이전트 100개 이상(QA 30명, Security 30명, Architecture 40명) 백엔드 서버에 즉각 동원!
> 백엔드 시스템이 완전히 무결해질 때까지 절대 멈추지 말고 무한 루프 검증을 실행하라.

## [범용 시스템 무한 진화! (Infinite Evolution) - 백엔드 서버 편]
Target: `my-server-test` (Node.js API Server)
Working directory: `/Users/user/src/my-server-test`
Integrity mode: benchmark

### 🚨 Rule 0. 창의적 기능 추가 절대 금지
- 불필요한 신규 API 라우트나 예측 불가능한 기믹은 일절 추가하지 마라.
- 오직 엔터프라이즈급 "백엔드 안정성(Stability), DDoS 방어, 서드파티 통신 복구"에만 100% 자원을 집중하라.

---

### 🔍 R1. 백엔드 결함 제로 QA 및 프로세스 누수 차단
- 백엔드 소스코드(`api/`, `scripts/`, `lib/`) 내의 물리적 에러 및 Unhandled Promise Rejection을 전부 추적하여 완벽히 수정하라.
- Node.js 프로세스 레벨의 메모리 누수를 스캔하고, 쓰레기 객체가 쌓이지 않도록(Zero-GC) 아키텍처를 최적화하라.

### 🌐 R2. API 트래픽 방어(Rate Limiting) 및 429 폴백 아키텍처
- 외부 서드파티(Naver SMTP, Supabase 등) 통신 시 발생하는 429 Quota 에러를 방어하기 위해 메시지 큐(Queue) 시스템과 Full-Jitter 지수 백오프를 이식하라.
- 비정상적인 트래픽 폭주나 악의적 호출을 막기 위한 엔드포인트 Rate Limiting(속도 제한)을 즉시 적용하라.

### 💣 R3. 백엔드 카오스 봇 투입 및 트랜잭션 자체 복구
- 10명의 가상 카오스 봇(Chaos bots)을 투입해 동시다발적인 대규모 API 호출 스팸 및 악성 JSON 페이로드 주입을 시뮬레이션하라.
- 트랜잭션 롤백 실패나 글리치가 발견될 경우 즉각 자체 복구(Autonomous remediate) 코드를 작성하고 영구 방어 테스트를 추가하라.

---
### 🏆 Acceptance Criteria
- [ ] 꼼수(ts-ignore 등) 없이 백엔드 전체 테스트 100% 통과 (Exit code 0)
- [ ] 카오스 봇의 악성 페이로드 및 DDoS 공격을 Rate Limit으로 완벽히 방어했는가?
- [ ] SMTP/DB 통신 429 에러 시 큐(Queue)를 통한 무중단 재시도 로직이 커밋 완료되었는가?


## 2026-10-08T05:08:38Z

# Teamwork Project Prompt

> Requested team: This is a single self-contained fix; keep it small and focused.

어제 서버 과부하(429 에러)로 중단되었던 백엔드 서버(`my-server-test`)의 시스템 안정화 작업을 재시도합니다. 외부 API 429 에러 방어를 위한 폴백 큐(Queue)를 구축하고, 트래픽 제한(Rate Limiting)을 이식하는 프로젝트입니다.

Working directory: /Users/user/src/my-server-test
Integrity mode: development

## Requirements

### R1. 서드파티 통신 429 에러 폴백(Fallback) 구축
Naver SMTP나 DB 통신 시 429 에러가 발생하더라도 요청이 유실되지 않고 안전하게 재시도(지수 백오프)되거나 로컬 큐에 저장되도록 무중단 복구 구조를 구현해야 합니다.

### R2. 엔드포인트 트래픽 제한 (Rate Limiting)
악의적인 다중 호출 스팸이나 카오스 테스트에도 백엔드 프로세스가 뻗지 않도록 주요 API 엔드포인트에 Rate Limiter를 장착해야 합니다.

## Acceptance Criteria

### Verification
- [ ] `npm run test` (또는 로컬 테스트 스크립트)를 실행했을 때 전체 백엔드 테스트가 에러 없이 100% 통과해야 합니다.
- [ ] 테스트 코드 내에 의도적인 트래픽 스팸(DDoS 시뮬레이션)을 발생시켰을 때, Rate Limiter가 정상 작동하여 서버가 멈추지 않고 차단 상태(429)를 정상 반환해야 합니다.
