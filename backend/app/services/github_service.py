"""GitHub integration service — per-project Personal Access Token.

Each project stores its own github_token + repo in the github_connections table.
No shared GitHub App credentials required.
"""
from __future__ import annotations

import base64
import httpx

from app.db import get_supabase

GITHUB_API = "https://api.github.com"

_HEADERS = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}


def _auth(token: str) -> dict:
    return {**_HEADERS, "Authorization": f"Bearer {token}"}


async def get_connection_for_project(project_id: str) -> dict | None:
    """Return {token, owner, repo} for a project, or None if not connected."""
    db = get_supabase()
    resp = (
        db.table("github_connections")
        .select("github_token,repo_owner,repo_name")
        .eq("project_id", project_id)
        .execute()
    )
    if not resp.data:
        return None
    row = resp.data[0]
    if not row.get("github_token") or not row.get("repo_name"):
        return None
    return {
        "token": row["github_token"],
        "owner": row["repo_owner"],
        "repo": row["repo_name"],
    }


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
        ref_resp.raise_for_status()
        sha = ref_resp.json()["object"]["sha"]

        create_resp = await client.post(
            f"{GITHUB_API}/repos/{owner}/{repo}/git/refs",
            headers=_auth(token),
            json={"ref": f"refs/heads/{branch}", "sha": sha},
        )
        return create_resp.status_code in (201, 422)  # 422 = already exists


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
) -> str | None:
    """Open a PR against the default branch. Returns HTML URL or None."""
    async with httpx.AsyncClient() as client:
        # Get default branch
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
            return resp.json()["html_url"]
    return None


async def create_pr_for_task(task_id: str, task_title: str, deliverable_content: str) -> str | None:
    """
    Full flow: look up project connection → create branch → commit deliverable → open PR.
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
        file_path = f".ownflow/tasks/{task_id[:8]}_{safe_title}.md"
        await commit_file(
            token, owner, repo, branch, file_path,
            deliverable_content,
            f"feat: OwnFlow deliverable — {task_title}",
        )

        pr_url = await open_pull_request(
            token, owner, repo, branch,
            title=f"[OwnFlow] {task_title}",
            body=(
                f"**Task:** {task_title}\n\n"
                f"**Task ID:** `{task_id}`\n\n"
                f"---\n\n{deliverable_content[:3000]}"
                + ("…\n\n_(truncated — see file for full deliverable)_" if len(deliverable_content) > 3000 else "")
            ),
        )

        if pr_url:
            db.table("tasks").update({"github_pr_url": pr_url}).eq("id", task_id).execute()

        return pr_url
    except Exception:
        return None
