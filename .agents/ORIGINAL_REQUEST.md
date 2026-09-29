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

## Follow-up — 2026-09-17T11:19:07Z

Perform an exhaustive architectural analysis and create comprehensive documentation for the entire my-server-test codebase, including all inactive endpoints and utilities. Use a very large team of agents.

Working directory: /Users/user/src/my-server-test
Integrity mode: development

STRICT CONSTRAINTS (USER MANDATED):
- ABSOLUTELY NO CODE MODIFICATIONS in the source tree (`/Users/user/src/my-server-test`). This is a read-only analysis task to prepare for future refactoring.
- DO NOT ask the user any questions. Make reasonable assumptions and proceed.

## Requirements

### R1. Comprehensive Codebase Analysis
Analyze the entire source tree in `/Users/user/src/my-server-test`, covering all active and inactive endpoints (e.g., inside `src/endpoints`), utility functions (e.g., `lib/llm`, `lib/sms`, `lib/supabase`), scripts, and deployment configurations (`vercel.json`, `lambda-src`). Understand every aspect of the codebase to prepare for a major refactoring.

### R2. Architectural Documentation
Generate a detailed architectural design document in Markdown format named `ARCHITECTURE.md` (save this inside `/Users/user/.gemini/antigravity/brain/35edf65c-137b-4bc8-892f-a3fc066b4b80/` or a workspace if created). The document must include Mermaid diagrams visualizing the data flow, component dependencies, and system architecture. It should identify areas that need refactoring.

### R3. Special Architectural Patterns
The documentation must explicitly describe the project's unique Vercel Node serverless deployment strategy (the single CJS bundle approach in `api/index.js`) and the Lazy Proxy pattern used for Supabase client initialization.

## Acceptance Criteria

### Documentation Completeness
- [ ] A final `ARCHITECTURE.md` file is generated containing valid Mermaid diagrams, exhaustively detailing the system.
- [ ] The document explicitly catalogs both active and inactive endpoints found in the codebase.
- [ ] The document accurately details the Vercel deployment flow and the Supabase Lazy Proxy pattern.
- [ ] The document includes a section highlighting potential areas for refactoring based on the deep understanding gained.

### Independent Verification
- [ ] An independent reviewer agent must cross-reference the generated document against the actual source tree in `/Users/user/src/my-server-test` to ensure no major modules or scripts were omitted, and explicitly state their approval in the output.
