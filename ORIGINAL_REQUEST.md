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
