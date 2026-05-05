# GitHub Copilot Instructions — OwnFlow

> Source of truth for commit/push discipline: `/memories/workflow.md`

---

## Commit & push — STRICT rules

**NEVER commit or push unless the user explicitly says "commit", "tested", or "commit changes".**

This applies to:
- Feature work
- Bug fixes
- CI/config-only changes
- Tiny one-line patches
- Responses to CI error reports

Reporting a bug or CI failure is **not** a commit trigger.

### When the user says "commit" / "tested"
1. Run `make check-backend` and/or `make check-frontend` (whichever apply to the changed code).
2. Only if all checks pass: `git add -A && git commit -m "<descriptive message>"`
3. `git push`
4. Append an entry to `DEVLOG.md` with date, feature summary, and commit hash.

---

## Checks

| Area     | Command                  |
|----------|--------------------------|
| Backend  | `make check-backend`     |
| Frontend | `make check-frontend`    |

Never skip checks. Never use `--no-verify`.

---

## GitHub Actions versions

Use these exact versions — do **not** downgrade:
- `actions/checkout@v6`
- `actions/setup-node@v6`
- `actions/setup-python@v6`

---

## General coding rules

- Only make changes that are directly requested or clearly necessary.
- Do not add features, refactor, or "improve" beyond what was asked.
- Do not add docstrings/comments/type annotations to code you didn't change.
- Read a file before modifying it.
