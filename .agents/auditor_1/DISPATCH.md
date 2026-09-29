# Auditor 1 Dispatch

## Mission
Perform forensic integrity audit of the generated architectural deliverable (`ARCHITECTURE.md`) and verify strict adherence to constraints, particularly ensuring zero source code modifications in `/Users/user/src/my-server-test`.

## Target Deliverable to Audit
`/Users/user/.gemini/antigravity/brain/35edf65c-137b-4bc8-892f-a3fc066b4b80/ARCHITECTURE.md`

## Audit Criteria
1. **Source Tree Integrity**:
   - Check git status or file modifications in `/Users/user/src/my-server-test` to verify that ABSOLUTELY ZERO source code files have been modified or created in the project repository (excluding metadata in `.agents/`).
2. **Document Authenticity**:
   - Verify that the architectural descriptions are genuinely derived from the codebase and not hallucinated or stubbed out.
   - Verify that all code snippets, file paths, and configuration keys mentioned in `ARCHITECTURE.md` match actual source files.
3. **Verdict**:
   - Report CLEAN or INTEGRITY VIOLATION.

## Strict Constraint
STRICT READ-ONLY. Do NOT modify any source code in `/Users/user/src/my-server-test`.

## Output Requirements
Write your audit report to: `/Users/user/src/my-server-test/.agents/auditor_1/audit.md`
Write your formal handoff to: `/Users/user/src/my-server-test/.agents/auditor_1/handoff.md`
Send message to parent orchestrator with verdict.

## 2026-09-17T11:29:17Z
You are Auditor 1 (teamwork_preview_auditor).
Your working directory is: /Users/user/src/my-server-test/.agents/auditor_1
Authoritative request: /Users/user/src/my-server-test/.agents/ORIGINAL_REQUEST.md
Your dispatch instructions: /Users/user/src/my-server-test/.agents/auditor_1/DISPATCH.md

STRICT CONSTRAINT:
ABSOLUTELY NO CODE MODIFICATIONS in /Users/user/src/my-server-test. This is a read-only audit task.

TASK:
Perform a forensic integrity audit on the generated artifact:
`/Users/user/.gemini/antigravity/brain/35edf65c-137b-4bc8-892f-a3fc066b4b80/ARCHITECTURE.md`
and the repository state.

AUDIT CHECKS:
1. Verify source tree cleanliness: Run `git status --porcelain` to verify that no source code files in `/Users/user/src/my-server-test` were modified or created (only `.agents/` metadata is permitted).
2. Authenticity: Verify that the architectural descriptions, paths, signatures, code samples, and patterns in `ARCHITECTURE.md` correspond to actual files in the repository and are not fabricated or dummy implementations.
3. Determine verdict: CLEAN or INTEGRITY VIOLATION.

OUTPUT:
Write audit report to: `/Users/user/src/my-server-test/.agents/auditor_1/audit.md`
Write formal handoff report to: `/Users/user/src/my-server-test/.agents/auditor_1/handoff.md`
Send a message back to parent orchestrator with your verdict.

