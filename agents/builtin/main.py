"""
OwnFlow — Built-in Agent
========================
Spawned by OwnFlow's Docker runner for every task whose actor has no webhook_url.

Flow
----
1. Parse the JSON dispatch payload from the PAYLOAD env var.
2. Call the configured AI provider (OpenAI or Anthropic based on model prefix).
3. Parse any ###FILES### block from the AI response.
4. If files were produced and a GitHub token is present, create a branch,
   commit the files, and open a PR.
5. POST the deliverable back to OwnFlow via callback_url:
   - If a PR was created: ``files`` is omitted, ``pr_url`` is set.
   - If no PR was created: ``files`` is included so the OwnFlow callback
     handler can attempt PR creation server-side.

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
    print("[builtin-agent] ERROR: PAYLOAD env var not set", flush=True)
    sys.exit(1)

payload: dict = json.loads(PAYLOAD_RAW)

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

MODEL: str = payload.get("model", "gpt-4o")
ACTOR: dict = payload.get("actor") or {}
ACTOR_ROLE: str = ACTOR.get("role") or ""
ACTOR_CAPABILITIES: list = ACTOR.get("capabilities") or []


def _build_system_prompt() -> str:
    role_line = f"You are acting as: **{ACTOR_ROLE}**" if ACTOR_ROLE else "You are an AI actor working on a software project."
    cap_lines = ""
    if ACTOR_CAPABILITIES:
        caps = "\n".join(f"- {c}" for c in ACTOR_CAPABILITIES if c)
        cap_lines = f"\n\n## Your capabilities\n{caps}"

    return f"""\
{role_line}
You will be given a task with its description and project context.
Produce a high-quality, detailed deliverable for the task.
Apply the expertise and perspective appropriate to your role.
If the task is code-related, write complete, working code with comments.
If the task is research or analysis, provide structured findings.
Format your response in Markdown.{cap_lines}

## Code tasks — file output
If the task produces one or more source code files, append a ###FILES### block at the
very end of your response (after all narrative / explanation). The block must be a
valid JSON array where every item has "path" (repo-relative path) and "content"
(full file text). Example:

###FILES###
[
  {{"path": "src/auth/login.py", "content": "# Login handler\\n..."}},
  {{"path": "tests/test_login.py",  "content": "import pytest\\n..."}}
]

Only include actual source/config/test files in the ###FILES### block.
Never include binary files or generated lock files.
If the task is not code-related (design, research, review, etc.) omit the ###FILES### block entirely.
"""


SYSTEM_PROMPT = _build_system_prompt()


# ── AI provider call ──────────────────────────────────────────────────────────

async def call_ai(prompt: str) -> str:
    """Call the appropriate AI provider based on MODEL."""
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
    branch = f"ownflow/task-{task_id[:8]}-{uuid.uuid4().hex[:6]}"
    api = f"https://api.github.com/repos/{repo}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Get default branch SHA
        repo_resp = await client.get(api, headers=headers)
        repo_resp.raise_for_status()
        default_branch = repo_resp.json()["default_branch"]

        ref_resp = await client.get(f"{api}/git/ref/heads/{default_branch}", headers=headers)
        ref_resp.raise_for_status()
        base_sha = ref_resp.json()["object"]["sha"]

        # Resolve the tree SHA from the commit (base_sha is a commit SHA, not a tree SHA)
        commit_resp_base = await client.get(f"{api}/git/commits/{base_sha}", headers=headers)
        commit_resp_base.raise_for_status()
        base_tree_sha = commit_resp_base.json()["tree"]["sha"]

        # Create branch
        await client.post(f"{api}/git/refs", headers=headers,
                          json={"ref": f"refs/heads/{branch}", "sha": base_sha})

        # Create blobs and tree
        tree_items = []
        for f in files:
            blob = await client.post(f"{api}/git/blobs", headers=headers,
                                     json={"content": base64.b64encode(
                                         f["content"].encode()).decode(),
                                         "encoding": "base64"})
            blob.raise_for_status()
            tree_items.append({
                "path": f["path"], "mode": "100644",
                "type": "blob", "sha": blob.json()["sha"],
            })

        tree_resp = await client.post(f"{api}/git/trees", headers=headers,
                                      json={"base_tree": base_tree_sha, "tree": tree_items})
        tree_resp.raise_for_status()
        tree_sha = tree_resp.json()["sha"]

        # Commit
        commit_resp = await client.post(f"{api}/git/commits", headers=headers,
                                        json={"message": f"feat: {task_title}",
                                              "tree": tree_sha, "parents": [base_sha]})
        commit_resp.raise_for_status()
        commit_sha = commit_resp.json()["sha"]

        # Update branch ref
        await client.patch(f"{api}/git/refs/heads/{branch}", headers=headers,
                           json={"sha": commit_sha})

        # Open PR
        pr_resp = await client.post(f"{api}/pulls", headers=headers,
                                    json={"title": f"feat: {task_title}",
                                          "head": branch, "base": default_branch,
                                          "body": f"Generated by OwnFlow built-in agent\nTask: {task_id}"})
        pr_resp.raise_for_status()
        return pr_resp.json()["html_url"]


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    task_info = payload["task"]
    project_info = payload["project"]
    github_info = payload.get("github") or {}
    callback_url: str = payload["callback_url"]
    callback_token: str = payload["callback_token"]
    task_id: str = payload["task_id"]

    logs: list[str] = []

    def log(msg: str, level: str = "INFO") -> None:
        from datetime import datetime
        ts = datetime.utcnow().strftime("%H:%M:%S")
        line = f"[{ts}] [{level}] {msg}"
        logs.append(line)
        print(line, flush=True)

    log(f"task={task_id!r} role={ACTOR_ROLE!r} model={MODEL}")

    prompt = (
        f"Project: {project_info['name']}\n"
        f"Project brief: {project_info.get('brief', '')}\n\n"
        f"Task title: {task_info['title']}\n"
        f"Task description: {task_info.get('description', '')}\n"
        f"Task type: {task_info.get('type', 'code')}  |  "
        f"Priority: {task_info.get('priority', 'medium')}\n"
    )
    if ACTOR_ROLE:
        prompt += f"\nYour assigned role for this task: {ACTOR_ROLE}\n"

    log("Calling AI provider...")
    content = await call_ai(prompt)
    log(f"AI responded ({len(content)} chars)")

    files = parse_files(content)
    log(f"Parsed {len(files)} file(s) from response")

    pr_url: Optional[str] = None
    gh_repo = github_info.get("repo")
    gh_token = github_info.get("token")
    if files and gh_repo and gh_token:
        try:
            pr_url = await create_pr(gh_token, gh_repo, task_id, task_info["title"], files)
            log(f"PR created: {pr_url}")
        except Exception as exc:
            log(f"PR creation failed: {exc}", level="ERROR")
    elif files:
        log("Files parsed but no GitHub connection — skipping PR")
    else:
        log("No files in response — skipping PR")

    if pr_url:
        content += f"\n\n**GitHub PR:** {pr_url}"

    callback_body = {
        "task_id": task_id,
        "content": content,
        # If we already created a PR, don't send files back — the callback
        # handler would otherwise create a second PR for the same task.
        "files": files if (files and not pr_url) else None,
        "logs": logs,
        "prompt": prompt,
        "model": MODEL,
    }

    log(f"Sending callback to {callback_url}")
    async with httpx.AsyncClient(timeout=30.0) as client:
        cb_resp = await client.post(
            callback_url,
            json=callback_body,
            headers={
                "Authorization": f"Bearer {callback_token}",
                "Content-Type": "application/json",
            },
        )
        cb_resp.raise_for_status()

    log("Callback OK — task done")


if __name__ == "__main__":
    asyncio.run(main())
