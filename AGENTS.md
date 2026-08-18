# Agent Instructions

Use simple English in code comments, documentation, errors, and user-facing
output.

## Product sources

- Read `SPEC.md` before changing product behavior.
- Read `docs/ARCHITECTURE.md` before changing code boundaries.
- Read `docs/ROADMAP.md` before widening the current milestone.
- Keep the CLI and future HTTP API as transports over the same environment
  engine.
- Treat pull request code as untrusted.
- Do not put provider credentials inside created environments.
- Do not claim an environment is ready until the readiness contract passes.

## Repository care

- Preserve unrelated work.
- Keep JSON output stable and send progress to standard error.
- Add or update tests when behavior changes.
- Update the product docs in the same change when a contract changes.
