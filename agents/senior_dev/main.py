"""
OwnFlow — Senior Developer Agent
=================================
A standalone webhook agent that:
  1. Receives a task from OwnFlow via POST /run
  2. Uses Claude to generate code / analysis
  3. Creates a GitHub branch + commits files + opens a PR (if repo connected)
  4. POSTs results back to OwnFlow via the callback URL

Environment variables (see .env.example):
  ANTHROPIC_API_KEY   — Claude API key (required)
  AGENT_API_KEY       — Optional secret OwnFlow sends as X-Api-Key header
  MODEL               — Anthropic model to use (default: claude-haiku-4-5)
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import secrets
import uuid
from datetime import datetime
from typing import Optional

import anthropic
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

load_dotenv()

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
AGENT_API_KEY = os.environ.get("AGENT_API_KEY", "")
MODEL = os.environ.get("MODEL", "claude-haiku-4-5")

app = FastAPI(title="OwnFlow Senior Developer Agent")

_anthropic = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)


# ── Request / response models ─────────────────────────────────────────────────

class GithubInfo(BaseModel):
    repo: Optional[str] = None   # "owner/repo"
    token: Optional[str] = None


class TaskInfo(BaseModel):
    title: str
    description: str = ""
    type: str = "code"
    priority: str = "medium"


class ProjectInfo(BaseModel):
    name: str
    brief: str = ""


class RunPayload(BaseModel):
    task_id: str
    callback_url: str
    callback_token: str
    task: TaskInfo
    project: ProjectInfo
    github: Optional[GithubInfo] = None


# ── Endpoint ──────────────────────────────────────────────────────────────────

@app.post("/run")
async def run_task(request: Request, body: RunPayload):
    """Accept a task from OwnFlow and process it asynchronously."""
    if AGENT_API_KEY:
        provided = request.headers.get("X-Api-Key", "")
        if not secrets.compare_digest(provided, AGENT_API_KEY):
            raise HTTPException(403, "Invalid API key.")
    asyncio.create_task(_process(body))
    return {"accepted": True, "task_id": body.task_id}


@app.get("/health")
async def health():
    return {"ok": True}


# ── Core processing ───────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are a senior software developer working on a project. You will receive a task and must
produce a complete, production-ready implementation.

## Output format
Always structure your response as:

### Summary
<2-3 sentence summary of what you built>

### Implementation
<detailed explanation of decisions and approach>

### Files
List every file you are creating or modifying.

###FILES###
[
  {"path": "src/example.py", "content": "# full file content here"},
  {"path": "tests/test_example.py", "content": "# full test content"}
]

Rules:
- The ###FILES### block MUST be valid JSON — an array of objects with "path" and "content" keys.
- Include the COMPLETE file content (no placeholders, no truncation).
- Use relative paths from the project root.
- Always include relevant tests when producing code.
"""


async def _process(body: RunPayload) -> None:
    logs: list[str] = []

    def log(msg: str):
        ts = datetime.utcnow().strftime("%H:%M:%S")
        logs.append(f"[{ts}] {msg}")
        print(msg)

    try:
        log(f"Task received: {body.task.title!r} (id={body.task_id})")

        # ── 1. Call Claude ────────────────────────────────────────────────────
        log("Calling Claude…")
        user_msg = (
            f"Project: {body.project.name}\n"
            f"Project brief: {body.project.brief}\n\n"
            f"Task title: {body.task.title}\n"
            f"Task description: {body.task.description}\n"
            f"Task type: {body.task.type}  |  Priority: {body.task.priority}\n"
        )

        response = await _anthropic.messages.create(
            model=MODEL,
            max_tokens=8192,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )
        content_text: str = response.content[0].text
        log(f"Claude responded ({len(content_text)} chars, {response.usage.output_tokens} tokens)")

        # ── 2. Parse files ────────────────────────────────────────────────────
        files = _parse_files(content_text)
        log(f"Parsed {len(files)} file(s) from response")

        # ── 3. GitHub PR ──────────────────────────────────────────────────────
        pr_url: str | None = None
        gh = body.github
        if gh and gh.repo and gh.token and files:
            try:
                pr_url = await _create_pr(
                    token=gh.token,
                    repo=gh.repo,
                    task_id=body.task_id,
                    task_title=body.task.title,
                    files=files,
                    log=log,
                )
            except Exception as exc:
                log(f"GitHub PR creation failed: {exc}")
        else:
            if not files:
                log("No files to push — skipping PR")
            else:
                log("No GitHub connection — skipping PR")

        # ── 4. Build deliverable content ──────────────────────────────────────
        log_block = "\n\n---\n### Agent logs\n```\n" + "\n".join(logs) + "\n```"
        deliverable = content_text + log_block
        if pr_url:
            deliverable += f"\n\n**GitHub PR:** {pr_url}"

        # ── 5. Callback to OwnFlow ─────────────────────────────────────────────
        # If this agent already created a PR, send pr_url and omit files so the
        # OwnFlow callback handler does not open a second PR for the same task.
        callback_body = {
            "task_id": body.task_id,
            "content": deliverable,
            "files": files if (files and not pr_url) else None,
            "pr_url": pr_url,
        }
        log(f"Calling back to OwnFlow at {body.callback_url}")
        async with httpx.AsyncClient(timeout=30.0) as client:
            cb_resp = await client.post(
                body.callback_url,
                json=callback_body,
                headers={
                    "Authorization": f"Bearer {body.callback_token}",
                    "Content-Type": "application/json",
                },
            )
        if cb_resp.status_code == 200:
            log("Callback successful — task marked done.")
        else:
            log(f"Callback returned HTTP {cb_resp.status_code}: {cb_resp.text[:200]}")

    except Exception as exc:
        print(f"[senior_dev] Unhandled error for task {body.task_id}: {exc}")


# ── File parser ───────────────────────────────────────────────────────────────

def _parse_files(text: str) -> list[dict]:
    """Extract the JSON array after ###FILES###."""
    marker = "###FILES###"
    idx = text.find(marker)
    if idx == -1:
        return []
    raw = text[idx + len(marker):].strip()
    # Find the outermost JSON array
    bracket = raw.find("[")
    if bracket == -1:
        return []
    # Walk to find matching closing bracket
    depth = 0
    end = bracket
    for i, ch in enumerate(raw[bracket:], start=bracket):
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    try:
        parsed = json.loads(raw[bracket:end + 1])
        return [f for f in parsed if isinstance(f, dict) and "path" in f and "content" in f]
    except json.JSONDecodeError:
        return []


# ── GitHub PR helper ──────────────────────────────────────────────────────────

async def _create_pr(
    token: str,
    repo: str,
    task_id: str,
    task_title: str,
    files: list[dict],
    log,
) -> str:
    """Create a GitHub branch, commit files, open a PR. Returns the PR URL."""
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    base_url = f"https://api.github.com/repos/{repo}"
    branch_name = f"ownflow/task-{task_id[:8]}-{uuid.uuid4().hex[:6]}"

    async with httpx.AsyncClient(timeout=30.0, headers=headers) as gh:
        # Get default branch SHA
        repo_resp = await gh.get(base_url)
        repo_resp.raise_for_status()
        default_branch = repo_resp.json()["default_branch"]
        log(f"GitHub: default branch = {default_branch!r}")

        ref_resp = await gh.get(f"{base_url}/git/ref/heads/{default_branch}")
        ref_resp.raise_for_status()
        base_sha = ref_resp.json()["object"]["sha"]

        # Create branch
        create_ref = await gh.post(f"{base_url}/git/refs", json={
            "ref": f"refs/heads/{branch_name}",
            "sha": base_sha,
        })
        create_ref.raise_for_status()
        log(f"GitHub: created branch {branch_name!r}")

        # Get current tree
        commit_resp = await gh.get(f"{base_url}/git/commits/{base_sha}")
        commit_resp.raise_for_status()
        tree_sha = commit_resp.json()["tree"]["sha"]

        # Create blob for each file
        tree_items = []
        for f in files:
            blob_resp = await gh.post(f"{base_url}/git/blobs", json={
                "content": base64.b64encode(f["content"].encode()).decode(),
                "encoding": "base64",
            })
            blob_resp.raise_for_status()
            tree_items.append({
                "path": f["path"],
                "mode": "100644",
                "type": "blob",
                "sha": blob_resp.json()["sha"],
            })

        # Create tree
        new_tree_resp = await gh.post(f"{base_url}/git/trees", json={
            "base_tree": tree_sha,
            "tree": tree_items,
        })
        new_tree_resp.raise_for_status()
        new_tree_sha = new_tree_resp.json()["sha"]

        # Create commit
        commit_msg = f"feat: {task_title}\n\nDelivered by OwnFlow Senior Dev Agent (task {task_id})"
        new_commit_resp = await gh.post(f"{base_url}/git/commits", json={
            "message": commit_msg,
            "tree": new_tree_sha,
            "parents": [base_sha],
        })
        new_commit_resp.raise_for_status()
        new_commit_sha = new_commit_resp.json()["sha"]

        # Update branch ref
        update_ref = await gh.patch(f"{base_url}/git/refs/heads/{branch_name}", json={
            "sha": new_commit_sha,
        })
        update_ref.raise_for_status()
        log(f"GitHub: committed {len(files)} file(s)")

        # Open PR
        safe_title = re.sub(r'[^\w\s\-]', '', task_title)[:72]
        pr_resp = await gh.post(f"{base_url}/pulls", json={
            "title": f"[OwnFlow] {safe_title}",
            "head": branch_name,
            "base": default_branch,
            "body": (
                f"Automated PR delivered by the OwnFlow Senior Developer Agent.\n\n"
                f"**Task:** {task_title}  \n"
                f"**Task ID:** `{task_id}`\n"
            ),
        })
        pr_resp.raise_for_status()
        pr_url = pr_resp.json()["html_url"]
        log(f"GitHub: PR opened → {pr_url}")
        return pr_url
