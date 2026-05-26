"""GitHub integration service — per-project Personal Access Token or OAuth token.

Each project stores its own github_token + repo in the github_connections table.
The token may come from a manually-entered PAT or from the GitHub OAuth App flow.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re

import httpx

from app.db import get_supabase
from app.config import get_settings

GITHUB_API = "https://api.github.com"

_HEADERS = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}


def _auth(token: str) -> dict:
    return {**_HEADERS, "Authorization": f"Bearer {token}"}


async def get_connection_for_project(project_id: str) -> dict | None:
    """
    Return {token, owner, repo} for a project, or None if not connected.

    Token resolution order:
      1. Project-level token in github_connections (PAT or project-scoped OAuth)
      2. Team-level token in team_github_tokens (team-wide OAuth connection)
    """
    db = get_supabase()
    resp = (
        db.table("github_connections")
        .select("github_token,repo_owner,repo_name")
        .eq("project_id", project_id)
        .execute()
    )
    if resp.data:
        row = resp.data[0]
        owner = row.get("repo_owner") or ""
        repo_name = row.get("repo_name") or ""
        token = row.get("github_token") or ""
        if not token:
            # No project-level token — try team-level
            token = await _get_team_token_for_project(project_id, db)
        if token and repo_name:
            return {"token": token, "owner": owner, "repo": repo_name}

    # No github_connections row at all — still try team token
    # (project might not have connected a repo yet)
    return None


async def _get_team_token_for_project(project_id: str, db=None) -> str:
    """Look up the team-level GitHub token for the project's team."""
    if db is None:
        db = get_supabase()
    project_resp = db.table("projects").select("team_id").eq("id", project_id).execute()
    if not project_resp.data or not project_resp.data[0].get("team_id"):
        return ""
    team_id = project_resp.data[0]["team_id"]
    token_resp = (
        db.table("team_github_tokens")
        .select("github_token")
        .eq("team_id", team_id)
        .execute()
    )
    if not token_resp.data:
        return ""
    return token_resp.data[0].get("github_token") or ""


async def get_team_token(team_id: str) -> str | None:
    """Return the stored GitHub token for a team, or None."""
    db = get_supabase()
    resp = (
        db.table("team_github_tokens")
        .select("github_token")
        .eq("team_id", team_id)
        .execute()
    )
    if not resp.data:
        return None
    return resp.data[0].get("github_token") or None


async def verify_token(token: str, owner: str, repo: str) -> str | None:
    """
    Verify the PAT can access the repo.
    Returns the authenticated username on success, or None on failure.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{GITHUB_API}/repos/{owner}/{repo}",
            headers=_auth(token),
        )
        if resp.status_code != 200:
            return None
        # Also grab the authenticated user
        user_resp = await client.get(f"{GITHUB_API}/user", headers=_auth(token))
        return user_resp.json().get("login") if user_resp.status_code == 200 else "unknown"


# ─── OAuth App flow ───────────────────────────────────────────────────────────

async def exchange_code(client_id: str, client_secret: str, code: str) -> str | None:
    """
    Exchange a GitHub OAuth callback code for an access token.
    Returns the access_token string or None on failure.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json"},
            json={"client_id": client_id, "client_secret": client_secret, "code": code},
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        return data.get("access_token") or None


async def get_authenticated_user(token: str) -> str | None:
    """Return the GitHub login for this token, or None."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{GITHUB_API}/user", headers=_auth(token))
        return resp.json().get("login") if resp.status_code == 200 else None


# ─── Repository listing ───────────────────────────────────────────────────────

async def list_repos(token: str) -> list[dict]:
    """
    Return all repos accessible by this token.
    Shape: [{"full_name": "owner/repo", "private": bool}]
    Fetches up to 10 pages (1000 repos) to handle large accounts.
    """
    results: list[dict] = []
    async with httpx.AsyncClient() as client:
        page = 1
        while True:
            resp = await client.get(
                f"{GITHUB_API}/user/repos",
                headers=_auth(token),
                params={"type": "all", "per_page": 100, "sort": "updated", "page": page},
            )
            if resp.status_code != 200:
                break
            batch = resp.json()
            if not batch:
                break
            results.extend({"full_name": r["full_name"], "private": r["private"]} for r in batch)
            if len(batch) < 100:
                break
            page += 1
            if page > 10:
                break
    return results


# ─── Webhook registration ─────────────────────────────────────────────────────

async def register_webhook(
    token: str,
    owner: str,
    repo: str,
    webhook_url: str,
    secret: str,
) -> bool:
    """
    Register an OwnFlow webhook on the repo for pull_request events.
    Returns True if created (201) or already exists (422).
    Silently returns False if the token doesn't have admin rights.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{GITHUB_API}/repos/{owner}/{repo}/hooks",
            headers=_auth(token),
            json={
                "name": "web",
                "active": True,
                "events": ["pull_request"],
                "config": {
                    "url": webhook_url,
                    "content_type": "json",
                    "secret": secret,
                    "insecure_ssl": "0",
                },
            },
        )
        return resp.status_code in (201, 422)


# ─── HMAC signature validation ────────────────────────────────────────────────

def verify_webhook_signature(body: bytes, signature_header: str, secret: str) -> bool:
    """Validate GitHub's X-Hub-Signature-256 header."""
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    received = signature_header[len("sha256="):]
    return hmac.compare_digest(expected, received)


# ─── Real code file extraction ────────────────────────────────────────────────

def parse_code_files(content: str) -> list[dict]:
    """
    Extract a ###FILES### block from an AI deliverable.

    The AI is instructed to end code-related responses with:

        ###FILES###
        [{"path": "src/foo.py", "content": "..."}]

    Returns a list of {path, content} dicts, or [] if not present / malformed.
    """
    marker = "###FILES###"
    idx = content.rfind(marker)
    if idx == -1:
        return []
    after = content[idx + len(marker):].strip()

    arr_start = after.find("[")
    if arr_start != -1:
        try:
            parsed, _ = json.JSONDecoder().raw_decode(after, arr_start)
            if isinstance(parsed, list):
                return [
                    {"path": str(f["path"]), "content": str(f["content"])}
                    for f in parsed
                    if isinstance(f, dict) and "path" in f and "content" in f
                ]
        except (json.JSONDecodeError, KeyError, TypeError):
            pass

    results = []
    path_pattern = re.compile(r'"path"\s*:\s*"((?:[^"\\]|\\.)*)"')
    content_pattern = re.compile(r'"content"\s*:\s*"((?:[^"\\]|\\.)*)"', re.DOTALL)

    paths = path_pattern.findall(after)
    contents = content_pattern.findall(after)

    print(f"[parse_code_files] Fallback regex: found {len(paths)} paths, {len(contents)} contents", flush=True)

    for path, file_content in zip(paths, contents):
        try:
            decoded_content = file_content.encode().decode('unicode_escape')
        except Exception:
            decoded_content = file_content
        results.append({"path": path, "content": decoded_content})

    return results

async def create_branch(token: str, owner: str, repo: str, branch: str) -> bool:
    """Create a new branch from the repo's default branch. Returns True on success."""
    async with httpx.AsyncClient() as client:
        # Find default branch
        repo_resp = await client.get(
            f"{GITHUB_API}/repos/{owner}/{repo}",
            headers=_auth(token),
        )
        repo_resp.raise_for_status()
        default_branch = repo_resp.json().get("default_branch", "main")

        ref_resp = await client.get(
            f"{GITHUB_API}/repos/{owner}/{repo}/git/ref/heads/{default_branch}",
            headers=_auth(token),
        )

        if ref_resp.status_code == 409 or ref_resp.status_code == 404:
            # 1. Blob для README
            blob_resp = await client.post(
                f"{GITHUB_API}/repos/{owner}/{repo}/git/blobs",
                headers=_auth(token),
                json={"content": "# OwnFlow Project\n", "encoding": "utf-8"},
            )
            if blob_resp.status_code != 201:
                return False
            blob_sha = blob_resp.json()["sha"]

            # 2. Tree
            tree_resp = await client.post(
                f"{GITHUB_API}/repos/{owner}/{repo}/git/trees",
                headers=_auth(token),
                json={"tree": [{"path": "README.md", "mode": "100644", "type": "blob", "sha": blob_sha}]},
            )
            if tree_resp.status_code != 201:
                return False
            tree_sha = tree_resp.json()["sha"]

            commit_resp = await client.post(
                f"{GITHUB_API}/repos/{owner}/{repo}/git/commits",
                headers=_auth(token),
                json={"message": "Initial commit by OwnFlow", "tree": tree_sha, "parents": []},
            )
            if commit_resp.status_code != 201:
                return False
            commit_sha = commit_resp.json()["sha"]

            default_ref_resp = await client.post(
                f"{GITHUB_API}/repos/{owner}/{repo}/git/refs",
                headers=_auth(token),
                json={"ref": f"refs/heads/{default_branch}", "sha": commit_sha},
            )
            if default_ref_resp.status_code not in (201, 422):
                return False

            create_resp = await client.post(
                f"{GITHUB_API}/repos/{owner}/{repo}/git/refs",
                headers=_auth(token),
                json={"ref": f"refs/heads/{branch}", "sha": commit_sha},
            )
            return create_resp.status_code in (201, 422)

        ref_resp.raise_for_status()
        sha = ref_resp.json()["object"]["sha"]

        create_resp = await client.post(
            f"{GITHUB_API}/repos/{owner}/{repo}/git/refs",
            headers=_auth(token),
            json={"ref": f"refs/heads/{branch}", "sha": sha},
        )
        return create_resp.status_code in (201, 422)

async def commit_file(
    token: str,
    owner: str,
    repo: str,
    branch: str,
    path: str,
    content: str,
    message: str,
) -> bool:
    """Create or update a file on the given branch."""
    encoded = base64.b64encode(content.encode()).decode()
    async with httpx.AsyncClient() as client:
        existing = await client.get(
            f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}",
            headers=_auth(token),
            params={"ref": branch},
        )
        body: dict = {"message": message, "content": encoded, "branch": branch}
        if existing.status_code == 200:
            body["sha"] = existing.json()["sha"]

        resp = await client.put(
            f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}",
            headers=_auth(token),
            json=body,
        )
        return resp.status_code in (200, 201)


async def open_pull_request(
    token: str,
    owner: str,
    repo: str,
    branch: str,
    title: str,
    body: str,
) -> dict | None:
    """Open a PR against the default branch. Returns {"url": ..., "number": ...} or None."""
    async with httpx.AsyncClient() as client:
        repo_resp = await client.get(
            f"{GITHUB_API}/repos/{owner}/{repo}",
            headers=_auth(token),
        )
        default_branch = repo_resp.json().get("default_branch", "main") if repo_resp.status_code == 200 else "main"

        resp = await client.post(
            f"{GITHUB_API}/repos/{owner}/{repo}/pulls",
            headers=_auth(token),
            json={"title": title, "body": body, "head": branch, "base": default_branch},
        )
        if resp.status_code == 201:
            data = resp.json()
            return {"url": data["html_url"], "number": data["number"]}
    return None


async def create_pr_for_task(task_id: str, task_title: str, deliverable_content: str) -> str | None:
    """
    Full flow: look up project connection → create branch → commit files → open PR.
    Returns PR URL or None if not connected / any step fails.
    """
    db = get_supabase()
    task_resp = db.table("tasks").select("project_id").eq("id", task_id).single().execute()
    if not task_resp.data:
        return None
    project_id = task_resp.data["project_id"]

    conn = await get_connection_for_project(project_id)
    if not conn:
        return None

    try:
        token, owner, repo = conn["token"], conn["owner"], conn["repo"]
        branch = f"ownflow/{task_id[:8]}"
        await create_branch(token, owner, repo, branch)

        safe_title = (
            "".join(c if c.isalnum() or c in "-_ " else "" for c in task_title)
            .strip()
            .replace(" ", "_")[:50]
        )

        # Extract real code files from ###FILES### block
        code_files = parse_code_files(deliverable_content)
        narrative = (
            deliverable_content[: deliverable_content.rfind("###FILES###")].strip()
            if code_files
            else deliverable_content
        )

        if code_files:
            for f in code_files:
                await commit_file(
                    token, owner, repo, branch,
                    f["path"], f["content"],
                    f"feat: {task_title} — {f['path']}",
                )
            # Also commit a summary note
            summary_path = f".ownflow/tasks/{task_id[:8]}_{safe_title}.md"
            await commit_file(
                token, owner, repo, branch, summary_path,
                narrative or deliverable_content,
                f"docs: OwnFlow task summary — {task_title}",
            )
        else:
            file_path = f".ownflow/tasks/{task_id[:8]}_{safe_title}.md"
            await commit_file(
                token, owner, repo, branch, file_path,
                deliverable_content,
                f"feat: OwnFlow deliverable — {task_title}",
            )

        pr_result = await open_pull_request(
            token, owner, repo, branch,
            title=f"[OwnFlow] {task_title}",
            body=(
                f"**Task:** [{task_title}]({get_settings().frontend_url.rstrip('/')}/projects/{project_id}?task={task_id})\n\n"
                + (f"_{len(code_files)} file(s) committed_\n\n" if code_files else "")
                + "---\n\n"
                + narrative[:3000]
                + ("\n\n_(truncated — see commits for full content)_" if len(narrative) > 3000 else "")
            ),
        )

        if pr_result:
            db.table("tasks").update({
                "github_pr_url": pr_result["url"],
                "github_pr_state": "open",
                "github_pr_number": pr_result["number"],
            }).eq("id", task_id).execute()
            return pr_result["url"]

    except Exception as exc:
        import traceback
        print(f"[create_pr_for_task] EXCEPTION: {type(exc).__name__}: {exc}", flush=True)
        print(traceback.format_exc(), flush=True)
        return None

    return None



# ─── Memory sync helpers ──────────────────────────────────────────────────────

async def list_merged_prs(token: str, owner: str, repo: str, limit: int = 20) -> list[dict]:
    """Return recently merged PRs for memory sync."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{GITHUB_API}/repos/{owner}/{repo}/pulls",
            headers=_auth(token),
            params={"state": "closed", "sort": "updated", "direction": "desc", "per_page": limit},
        )
        if resp.status_code != 200:
            return []
        return [
            {
                "number": pr["number"],
                "title": pr["title"],
                "body": pr.get("body") or "",
                "merged_by": (pr.get("merged_by") or {}).get("login", ""),
                "merged_at": pr.get("merged_at"),
            }
            for pr in resp.json()
            if pr.get("merged_at")
        ]
