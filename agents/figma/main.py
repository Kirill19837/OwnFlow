"""
OwnFlow — Figma Design Agent
============================
Spawned by OwnFlow's Docker runner for tasks assigned to a Figma-aware designer actor.

Flow
----
1. Parse the JSON dispatch payload from the PAYLOAD env var.
2. If FIGMA_TOKEN and figma_file_key are present, fetch Figma file metadata
   to enrich the prompt with current design context.
3. Call the configured AI provider (OpenAI or Anthropic based on model prefix)
   with a design-focused system prompt.
4. Parse any ###FILES### block from the AI response (design specs, CSS, component code).
5. If files were produced and a GitHub token is present, create a branch and open a PR.
6. POST the deliverable back to OwnFlow via callback_url.

Environment variables (resolved from company extra_env at dispatch time):
  PAYLOAD             — JSON dispatch payload from OwnFlow (required)
  OPENAI_API_KEY      — required when actor.model starts with "gpt"
  ANTHROPIC_API_KEY   — required when actor.model starts with "claude"
  FIGMA_TOKEN         — Figma personal access token (optional, enables design context)
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
    print("[figma-agent] ERROR: PAYLOAD env var not set", flush=True)
    sys.exit(1)

print(f"[figma-agent] DEBUG startup: PAYLOAD length={len(PAYLOAD_RAW)}", flush=True)
try:
    payload: dict = json.loads(PAYLOAD_RAW)
except json.JSONDecodeError as _e:
    print(f"[figma-agent] ERROR: PAYLOAD is not valid JSON: {_e}", flush=True)
    sys.exit(1)

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
FIGMA_TOKEN = os.environ.get("FIGMA_TOKEN", "")

print(
    f"[figma-agent] DEBUG startup: "
    f"OPENAI_API_KEY present={bool(OPENAI_API_KEY)} "
    f"ANTHROPIC_API_KEY present={bool(ANTHROPIC_API_KEY)} "
    f"FIGMA_TOKEN present={bool(FIGMA_TOKEN)}",
    flush=True,
)

MODEL: str = payload.get("model", "gpt-4o")
ACTOR: dict = payload.get("actor") or {}
ACTOR_ROLE: str = ACTOR.get("role") or "UI/UX Designer"
ACTOR_CAPABILITIES: list = ACTOR.get("capabilities") or []


SYSTEM_PROMPT = f"""\
You are acting as: **{ACTOR_ROLE}**
You specialise in UI/UX design, design systems, component specifications, and design-to-code translation.
You will be given a task with its description and project context.
Produce a high-quality design deliverable appropriate to the task.

If design context from Figma is provided, reference it to ensure consistency with existing designs.

## Output types by task
- UI component spec → detailed spec with layout, spacing, colours, states, accessibility notes
- Design-to-code → production-ready CSS/Tailwind + React/HTML component
- Design system → tokens, component library spec, usage guidelines
- UX research / audit → structured findings with recommendations
- Wireframe description → detailed layout spec (text-based wireframe)

## File output — REQUIRED for every task
You MUST always append a ###FILES### block at the very end of your response.
The block must be a valid JSON array where every item has "path" and "content" keys.

Path conventions:
- React components          → src/components/<ComponentName>.tsx
- CSS / Tailwind styles     → src/styles/<name>.css
- Design specs / docs       → docs/design/<kebab-case-title>.md
- Design tokens             → src/design-tokens.ts (or .json)
- UX research               → docs/research/<kebab-case-title>.md

Example:
###FILES###
[
  {{"path": "src/components/Button.tsx", "content": "import React from 'react'\\n..."}},
  {{"path": "docs/design/button-spec.md", "content": "# Button Component Spec\\n..."}}
]

Never omit the ###FILES### block — every task must produce at least one file.
"""


# ── Figma context ─────────────────────────────────────────────────────────────

async def fetch_figma_context(file_key: str) -> str:
    """Fetch Figma file metadata and return a text summary for the prompt."""
    if not FIGMA_TOKEN or not file_key:
        return ""
    print(f"[figma-agent] DEBUG figma: fetching file key={file_key!r}", flush=True)
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(
                f"https://api.figma.com/v1/files/{file_key}",
                headers={"X-Figma-Token": FIGMA_TOKEN},
            )
            resp.raise_for_status()
            data = resp.json()
            doc = data.get("document", {})
            name = data.get("name", file_key)
            pages = [c.get("name") for c in doc.get("children", []) if c.get("name")]
            print(f"[figma-agent] DEBUG figma: file={name!r} pages={pages}", flush=True)
            return (
                f"\n\n## Figma Design Context\n"
                f"File: {name}\n"
                f"Pages: {', '.join(pages) if pages else 'unknown'}\n"
                f"(Use this context to ensure design consistency with existing work.)\n"
            )
    except Exception as exc:
        print(f"[figma-agent] WARNING figma: context fetch failed: {exc}", flush=True)
        return ""


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
    branch = f"ownflow/design-{task_id[:8]}-{uuid.uuid4().hex[:6]}"
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

        create_ref_resp = await client.post(
            f"{api}/git/refs", headers=headers,
            json={"ref": f"refs/heads/{branch}", "sha": base_sha},
        )
        if create_ref_resp.status_code not in (200, 201, 422):
            create_ref_resp.raise_for_status()

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
            json={"message": f"design: {task_title}", "tree": tree_sha, "parents": [base_sha]},
        )
        commit_resp.raise_for_status()
        commit_sha = commit_resp.json()["sha"]

        await client.patch(f"{api}/git/refs/heads/{branch}", headers=headers, json={"sha": commit_sha})

        pr_resp = await client.post(
            f"{api}/pulls", headers=headers,
            json={
                "title": f"design: {task_title}",
                "head": branch,
                "base": default_branch,
                "body": f"Generated by OwnFlow Figma design agent\nTask: {task_id}",
            },
        )
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

    logs: list[dict] = []
    _LEVELS = {"DEBUG": 0, "INFO": 1, "WARNING": 2, "ERROR": 3}
    _PHASES = {"planning": 0, "agent_execution": 1, "external_dispatch": 2, "docker_dispatch": 3, "task_execution": 4}

    def log(msg: str, level: str = "INFO", phase: str = "agent_execution") -> None:
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        print(f"[{ts}] [{level}] {msg}", flush=True)
        logs.append({"level": _LEVELS.get(level.upper(), 1), "phase": _PHASES.get(phase, 1), "message": msg})

    log(f"task={task_id!r} role={ACTOR_ROLE!r} model={MODEL}")
    log(f"FIGMA_TOKEN present={bool(FIGMA_TOKEN)}", level="DEBUG", phase="planning")

    # Fetch Figma context if token + file key available
    figma_file_key = payload.get("figma_file_key") or ""
    figma_context = await fetch_figma_context(figma_file_key) if FIGMA_TOKEN else ""
    if figma_context:
        log(f"Fetched Figma context for file key={figma_file_key!r}", phase="planning")
    elif FIGMA_TOKEN and not figma_file_key:
        log("FIGMA_TOKEN present but no figma_file_key in payload — skipping Figma context", level="DEBUG", phase="planning")

    prompt = (
        f"Project: {project_info['name']}\n"
        f"Project brief: {project_info.get('brief', '')}\n"
        f"{figma_context}\n"
        f"Task title: {task_info['title']}\n"
        f"Task description: {task_info.get('description', '')}\n"
        f"Task type: {task_info.get('type', 'design')}  |  "
        f"Priority: {task_info.get('priority', 'medium')}\n"
    )
    if ACTOR_ROLE:
        prompt += f"\nYour assigned role for this task: {ACTOR_ROLE}\n"

    log(f"prompt_length={len(prompt)} chars", level="DEBUG", phase="planning")

    log(f"Calling AI provider (model={MODEL})...")
    t0 = datetime.now(timezone.utc)
    try:
        content = await call_ai(prompt)
    except Exception as exc:
        log(f"AI provider call failed: {type(exc).__name__}: {exc}", level="ERROR")
        raise
    elapsed = (datetime.now(timezone.utc) - t0).total_seconds()
    log(f"AI responded in {elapsed:.1f}s — {len(content)} chars")

    files = parse_files(content)
    log(f"Parsed {len(files)} file(s) from response")
    if not files:
        log("###FILES### marker missing or JSON parse failed", level="WARNING")

    pr_url: Optional[str] = None
    gh_repo = github_info.get("repo")
    gh_token = github_info.get("token")
    if files and gh_repo and gh_token:
        log(f"Creating PR on repo={gh_repo!r} for {len(files)} file(s)")
        try:
            pr_url = await create_pr(gh_token, gh_repo, task_id, task_info["title"], files)
            log(f"PR created: {pr_url}")
        except Exception as exc:
            log(f"PR creation failed: {type(exc).__name__}: {exc}", level="ERROR")
    elif files:
        log("Files parsed but no GitHub connection — skipping PR")
    else:
        log("No files — skipping PR")

    if pr_url:
        content += f"\n\n**GitHub PR:** {pr_url}"

    callback_body = {
        "task_id": task_id,
        "content": content,
        "files": files if (files and not pr_url) else None,
        "logs": logs,
        "prompt": prompt,
        "model": MODEL,
    }

    log(f"Sending callback to {callback_url}")
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            cb_resp = await client.post(
                callback_url,
                json=callback_body,
                headers={
                    "Authorization": f"Bearer {callback_token}",
                    "Content-Type": "application/json",
                },
            )
            log(f"Callback response status={cb_resp.status_code}", level="DEBUG")
            cb_resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            log(f"Callback HTTP error {exc.response.status_code}: {exc.response.text[:300]}", level="ERROR")
            raise

    log("Callback OK — task done")


if __name__ == "__main__":
    asyncio.run(main())
