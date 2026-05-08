"""
OwnFlow — Docs / Business Analyst Agent
========================================
Spawned by OwnFlow's Docker runner for tasks assigned to a Business Analyst actor.

Flow
----
1. Parse the JSON dispatch payload from the PAYLOAD env var.
2. Call the configured AI provider with a documentation-focused system prompt.
3. Parse any ###FILES### block from the AI response.
4. If files were produced and a GitHub token is present, create a branch and open a PR.
5. POST the deliverable back to OwnFlow via callback_url.
   Retries up to MAX_CALLBACK_ATTEMPTS times with exponential backoff.
   Exits non-zero if all attempts fail so the runner can surface / retry the task.

Environment variables:
  PAYLOAD             — JSON dispatch payload from OwnFlow (required)
  OPENAI_API_KEY      — required when actor.model starts with "gpt"
  ANTHROPIC_API_KEY   — required when actor.model starts with "claude"
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx

PAYLOAD_RAW = os.environ.get("PAYLOAD", "")
if not PAYLOAD_RAW:
    print("[docs-agent] ERROR: PAYLOAD env var not set", flush=True)
    sys.exit(1)

print(f"[docs-agent] DEBUG startup: PAYLOAD length={len(PAYLOAD_RAW)}", flush=True)
try:
    payload: dict = json.loads(PAYLOAD_RAW)
except json.JSONDecodeError as _e:
    print(f"[docs-agent] ERROR: PAYLOAD is not valid JSON: {_e}", flush=True)
    sys.exit(1)

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

print(
    f"[docs-agent] DEBUG startup: "
    f"OPENAI_API_KEY present={bool(OPENAI_API_KEY)} "
    f"ANTHROPIC_API_KEY present={bool(ANTHROPIC_API_KEY)}",
    flush=True,
)

MODEL: str = payload.get("model", "gpt-4o")
ACTOR: dict = payload.get("actor") or {}
ACTOR_ROLE: str = ACTOR.get("role") or "Business Analyst"

# Callback retry configuration.
# Total worst-case wait before giving up: 2 + 4 + 8 + 16 = 30 s, well inside any
# reasonable task timeout while still surviving transient 5xx / network blips.
MAX_CALLBACK_ATTEMPTS: int = 4
CALLBACK_BACKOFF_BASE: float = 2.0  # seconds; delay = base ** attempt_number

SYSTEM_PROMPT = f"""\
You are acting as: **{ACTOR_ROLE}**
You specialise in technical writing, business requirements, system documentation,
API specifications, architecture decision records, and process documentation.
You will be given a task with its description and project context.
Produce clear, structured, professional documentation appropriate to the task.

## Output types by task
- Business requirements (BRD/PRD) → structured doc with goals, scope, user stories, acceptance criteria
- Technical specification         → architecture overview, data models, API contracts, sequence diagrams (Mermaid)
- API documentation               → endpoint descriptions, request/response examples, error codes
- Architecture Decision Record    → ADR format: context, decision, consequences
- Process / runbook               → step-by-step with prerequisites and expected outcomes
- Meeting notes / summary         → structured summary with decisions and action items
- User story refinement           → INVEST-format stories with clear acceptance criteria

## File output — REQUIRED for every task
You MUST always append a ###FILES### block at the very end of your response.
The block must be a valid JSON array where every item has "path" and "content" keys.

Path conventions:
- Business requirements  → docs/requirements/<kebab-case-title>.md
- Technical specs        → docs/specs/<kebab-case-title>.md
- API docs               → docs/api/<kebab-case-title>.md
- ADRs                   → docs/adr/<NNN>-<kebab-case-title>.md
- Process / runbooks     → docs/runbooks/<kebab-case-title>.md
- General docs           → docs/<kebab-case-title>.md

Example:
###FILES###
[
  {{"path": "docs/requirements/user-auth.md", "content": "# User Authentication Requirements\\n..."}}
]

Never omit the ###FILES### block — every task must produce at least one file.
"""


# ── AI provider call ──────────────────────────────────────────────────────────

async def call_ai(prompt: str) -> str:
    if MODEL.startswith("claude"):
        return await _call_anthropic(prompt)
    return await _call_openai(prompt)


async def _call_openai(prompt: str) -> str:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set")
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": 8192,
            },
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


async def _call_anthropic(prompt: str) -> str:
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
            },
            json={
                "model": MODEL,
                "max_tokens": 8192,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        resp.raise_for_status()
        return resp.json()["content"][0]["text"]


# ── File parsing ──────────────────────────────────────────────────────────────

def parse_files(text: str) -> list[dict]:
    match = re.search(r"###FILES###\s*(\[.*\])", text, re.DOTALL)
    if not match:
        return []
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return []


# ── GitHub PR ─────────────────────────────────────────────────────────────────

async def create_pr(token: str, repo: str, task_id: str, task_title: str,
                    files: list[dict]) -> Optional[str]:
    branch = f"ownflow/docs-{task_id[:8]}-{uuid.uuid4().hex[:6]}"
    api = f"https://api.github.com/repos/{repo}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        repo_resp = await client.get(api, headers=headers)
        repo_resp.raise_for_status()
        default_branch = repo_resp.json()["default_branch"]

        ref_resp = await client.get(f"{api}/git/ref/heads/{default_branch}", headers=headers)
        ref_resp.raise_for_status()
        base_sha = ref_resp.json()["object"]["sha"]

        commit_resp_base = await client.get(f"{api}/git/commits/{base_sha}", headers=headers)
        commit_resp_base.raise_for_status()
        base_tree_sha = commit_resp_base.json()["tree"]["sha"]

        await client.post(
            f"{api}/git/refs", headers=headers,
            json={"ref": f"refs/heads/{branch}", "sha": base_sha},
        )

        tree_items = []
        for f in files:
            blob = await client.post(
                f"{api}/git/blobs", headers=headers,
                json={"content": base64.b64encode(f["content"].encode()).decode(), "encoding": "base64"},
            )
            blob.raise_for_status()
            tree_items.append({"path": f["path"], "mode": "100644", "type": "blob", "sha": blob.json()["sha"]})

        tree_resp = await client.post(
            f"{api}/git/trees", headers=headers,
            json={"base_tree": base_tree_sha, "tree": tree_items},
        )
        tree_resp.raise_for_status()
        tree_sha = tree_resp.json()["sha"]

        commit_resp = await client.post(
            f"{api}/git/commits", headers=headers,
            json={"message": f"docs: {task_title}", "tree": tree_sha, "parents": [base_sha]},
        )
        commit_resp.raise_for_status()
        commit_sha = commit_resp.json()["sha"]

        await client.patch(f"{api}/git/refs/heads/{branch}", headers=headers, json={"sha": commit_sha})

        pr_resp = await client.post(
            f"{api}/pulls", headers=headers,
            json={
                "title": f"docs: {task_title}",
                "head": branch,
                "base": default_branch,
                "body": f"Generated by OwnFlow Docs/BA agent\nTask: {task_id}",
            },
        )
        pr_resp.raise_for_status()
        return pr_resp.json()["html_url"]


# ── Callback delivery with retries ────────────────────────────────────────────

async def deliver_callback(
        callback_url: str,
        callback_token: str,
        payload_out: dict,
        log,  # callable(msg, level, phase)
) -> None:
    """POST payload_out to callback_url.

    Retries up to MAX_CALLBACK_ATTEMPTS times with exponential backoff.
    Raises RuntimeError if every attempt fails so the caller can exit non-zero.
    """
    last_exc: BaseException | None = None

    for attempt in range(1, MAX_CALLBACK_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    callback_url,
                    headers={"Authorization": f"Bearer {callback_token}"},
                    json=payload_out,
                )
                # Treat 4xx as non-retryable (bad payload / auth); 5xx as retryable.
                if 400 <= resp.status_code < 500:
                    raise RuntimeError(
                        f"Callback rejected with {resp.status_code} (non-retryable): "
                        f"{resp.text[:300]}"
                    )
                resp.raise_for_status()  # surfaces 5xx as httpx.HTTPStatusError
                log("Callback delivered successfully", phase="task_execution")
                return

        except RuntimeError:
            # Non-retryable — propagate immediately without further attempts.
            raise

        except (httpx.HTTPStatusError, httpx.RequestError, Exception) as exc:
            last_exc = exc
            if attempt < MAX_CALLBACK_ATTEMPTS:
                delay = CALLBACK_BACKOFF_BASE ** attempt
                log(
                    f"Callback attempt {attempt}/{MAX_CALLBACK_ATTEMPTS} failed "
                    f"({type(exc).__name__}: {str(exc)[:200]}); "
                    f"retrying in {delay:.0f}s",
                    level="WARNING",
                    phase="task_execution",
                )
                await asyncio.sleep(delay)
            else:
                log(
                    f"Callback attempt {attempt}/{MAX_CALLBACK_ATTEMPTS} failed "
                    f"({type(exc).__name__}: {str(exc)[:200]}); no more retries",
                    level="ERROR",
                    phase="task_execution",
                )

    raise RuntimeError(
        f"Callback delivery failed after {MAX_CALLBACK_ATTEMPTS} attempts: {last_exc}"
    )


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    task_info = payload["task"]
    project_info = payload["project"]
    github_info = payload.get("github") or {}
    callback_url: str = payload["callback_url"]
    callback_token: str = payload["callback_token"]
    task_id: str = payload["task_id"]

    logs: list[dict] = []
    _LEVELS = {"DEBUG": 0, "INFO": 1, "WARNING": 2, "ERROR": 3}
    _PHASES = {"planning": 0, "agent_execution": 1, "external_dispatch": 2, "docker_dispatch": 3, "task_execution": 4}

    def log(msg: str, level: str = "INFO", phase: str = "agent_execution") -> None:
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        print(f"[{ts}] [{level}] {msg}", flush=True)
        logs.append({"level": _LEVELS.get(level.upper(), 1), "phase": _PHASES.get(phase, 1), "message": msg})

    log(f"task={task_id!r} role={ACTOR_ROLE!r} model={MODEL}")

    prompt = (
        f"Project: {project_info['name']}\n"
        f"Project brief: {project_info.get('brief', '')}\n"
        f"Task title: {task_info['title']}\n"
        f"Task description: {task_info.get('description', '')}\n"
        f"Task type: {task_info.get('type', 'documentation')}  |  "
        f"Phase: {task_info.get('phase', '')}\n\n"
        f"Produce the documentation deliverable for this task."
    )

    log(f"Calling AI model={MODEL!r}", phase="task_execution")
    try:
        result = await call_ai(prompt)
    except Exception as exc:
        log(f"AI call failed: {exc}", level="ERROR", phase="task_execution")
        # Best-effort error callback — failures here are surfaced by the non-zero exit.
        try:
            await deliver_callback(
                callback_url, callback_token,
                {"task_id": task_id, "content": f"Agent error: {exc}", "logs": logs},
                log,
            )
        except Exception:
            pass
        sys.exit(1)

    log(f"AI response received length={len(result)}", phase="task_execution")

    files = parse_files(result)
    log(f"Parsed {len(files)} file(s) from ###FILES### block", phase="task_execution")

    # Strip ###FILES### block from deliverable text
    deliverable = re.sub(r"###FILES###.*$", "", result, flags=re.DOTALL).strip()

    pr_url: Optional[str] = None
    if files:
        github_token = github_info.get("token") or ""
        repo = github_info.get("repo") or ""
        if github_token and repo:
            log(f"Creating PR on {repo!r} with {len(files)} file(s)", phase="task_execution")
            try:
                pr_url = await create_pr(github_token, repo, task_id, task_info["title"], files)
                log(f"PR created: {pr_url}", phase="task_execution")
            except Exception as exc:
                log(f"PR creation failed: {exc}", level="WARNING", phase="task_execution")
        else:
            log("GitHub token or repo not configured — skipping PR", level="DEBUG", phase="task_execution")

    payload_out: dict = {
        "task_id": task_id,
        "content": deliverable,
        "files": files,
        "logs": logs,
        "prompt": prompt,
        "model": MODEL,
    }
    if pr_url:
        payload_out["pr_url"] = pr_url

    log(f"POSTing result to callback url={callback_url!r}", phase="task_execution")
    try:
        await deliver_callback(callback_url, callback_token, payload_out, log)
    except Exception as exc:
        log(str(exc), level="ERROR", phase="task_execution")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
