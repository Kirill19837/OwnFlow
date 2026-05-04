# OwnFlow — Agent Instructions

All AI coding agents working in this repository must follow the rules below.

---

## Commit & push discipline

**Do NOT commit or push unless the user explicitly says "commit", "tested", or "commit changes".**

- Fixing a bug → edit the file, confirm it works, then **stop and wait**.
- Receiving a CI error report → fix the code, confirm locally, then **stop and wait**.
- Small/config-only changes → same rule, no exceptions.

### Commit workflow (only when triggered)
1. `make check-backend` and/or `make check-frontend`
2. Only if all checks pass: `git add -A && git commit -m "<descriptive message>"`
3. `git push`
4. Append entry to `DEVLOG.md`: date, summary, commit hash.

---

## Checks

```
make check-backend    # ruff lint + pytest
make check-frontend   # eslint + tsc + vite build
```

Never skip. Never use `--no-verify`.

---

## Scope discipline

- Only change what was asked.
- Do not refactor, rename, or "improve" untouched code.
- Do not add comments, docstrings, or type annotations to code you didn't write.

---

## GitHub Actions

Always use:
- `actions/checkout@v6`
- `actions/setup-node@v6`
- `actions/setup-python@v6`

Do not downgrade to v4/v5.

---

## Stack quick-reference

| Layer    | Tech                                              |
|----------|---------------------------------------------------|
| Backend  | FastAPI · Python 3.13 · Supabase (service-role)   |
| Frontend | React 19 · Vite · TypeScript · Tailwind · Zustand |
| Agents   | Ephemeral Docker containers, callback contract    |
| CI/CD    | GitHub Actions → SSH deploy to VPS                |
