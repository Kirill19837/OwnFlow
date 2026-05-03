"""GitHub per-project integration endpoints.

Supports two connection modes:
  1. GitHub OAuth App — user clicks "Connect with GitHub" and authorizes
  2. Personal Access Token (PAT) — legacy fallback for users who prefer it

After connecting, AI agents automatically open PRs when tasks are executed.
Incoming webhooks from GitHub update task PR state (open/merged/closed).
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from app.config import get_settings
from app.db import get_supabase
from app.services.github_service import (
    exchange_code,
    get_authenticated_user,
    get_team_token,
    list_repos,
    register_webhook,
    verify_token,
    verify_webhook_signature,
)

def _backend_base(settings) -> str:
    """Resolve the public backend URL for webhook registration."""
    if settings.backend_url:
        return settings.backend_url.rstrip("/")
    # Derive from cors_origins — swap frontend port to backend port for local dev
    return settings.cors_origins.split(",")[0].strip().replace("http://localhost:5173", "http://localhost:8000")


router = APIRouter()


# ─── Pydantic models ──────────────────────────────────────────────────────────

class ConnectBody(BaseModel):
    token: str
    repo: str


class RepoBody(BaseModel):
    repo: str


# ─── OAuth flow ───────────────────────────────────────────────────────────────

@router.get("/oauth/start")
async def github_oauth_start(project_id: str = "", team_id: str = ""):
    """
    Begin the GitHub OAuth App flow.
    Pass either team_id (from team settings) or project_id (from project settings).
    Generates a CSRF state token, stores it, then returns the GitHub authorize URL.
    """
    if not project_id and not team_id:
        raise HTTPException(400, "Provide team_id or project_id.")
    settings = get_settings()
    if not settings.github_client_id:
        raise HTTPException(400, "GitHub OAuth App not configured. Set GITHUB_CLIENT_ID in .env.")

    state = secrets.token_hex(32)
    db = get_supabase()
    row: dict = {"state": state}
    if team_id:
        row["team_id"] = team_id
    else:
        row["project_id"] = project_id
    db.table("github_oauth_states").insert(row).execute()

    authorize_url = (
        f"https://github.com/login/oauth/authorize"
        f"?client_id={settings.github_client_id}"
        f"&scope=repo%20admin%3Arepo_hook"
        f"&state={state}"
    )
    return Response(status_code=302, headers={"Location": authorize_url})


@router.get("/oauth/callback")
async def github_oauth_callback(code: str, state: str):
    """
    GitHub redirects here after the user authorizes.
    Handles both team-level and project-level OAuth flows.
    """
    settings = get_settings()
    db = get_supabase()

    state_resp = (
        db.table("github_oauth_states")
        .select("project_id,team_id,created_at")
        .eq("state", state)
        .execute()
    )
    if not state_resp.data:
        raise HTTPException(400, "Invalid or expired OAuth state. Please try again.")

    row = state_resp.data[0]
    project_id = row.get("project_id") or ""
    team_id = row.get("team_id") or ""
    created_at = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
    if datetime.now(timezone.utc) - created_at > timedelta(minutes=10):
        db.table("github_oauth_states").delete().eq("state", state).execute()
        raise HTTPException(400, "OAuth state expired. Please try again.")

    db.table("github_oauth_states").delete().eq("state", state).execute()

    token = await exchange_code(settings.github_client_id, settings.github_client_secret, code)
    if not token:
        raise HTTPException(400, "Failed to exchange GitHub OAuth code for token.")

    login = await get_authenticated_user(token) or "unknown"

    # ── Team-level flow ──────────────────────────────────────────────────────
    if team_id:
        team_existing = (
            db.table("team_github_tokens").select("id").eq("team_id", team_id).execute()
        )
        if team_existing.data:
            db.table("team_github_tokens").update({
                "github_token": token,
                "github_user_login": login,
            }).eq("team_id", team_id).execute()
        else:
            db.table("team_github_tokens").insert({
                "team_id": team_id,
                "github_token": token,
                "github_user_login": login,
            }).execute()
        redirect_url = f"{settings.frontend_url.rstrip('/')}/teams/{team_id}/settings?github_connected=1"
        return Response(status_code=302, headers={"Location": redirect_url})

    # ── Project-level flow (legacy / per-project PAT-like OAuth) ─────────────
    existing = db.table("github_connections").select("id,repo_owner,repo_name").eq("project_id", project_id).execute()
    owner = ""
    repo_name = ""
    if existing.data:
        db.table("github_connections").update({
            "github_token": token,
            "github_user_login": login,
        }).eq("project_id", project_id).execute()
        owner = existing.data[0].get("repo_owner") or ""
        repo_name = existing.data[0].get("repo_name") or ""
    else:
        db.table("github_connections").insert({
            "project_id": project_id,
            "github_token": token,
            "github_user_login": login,
            "repo_owner": "",
            "repo_name": "",
        }).execute()

    if owner and repo_name:
        webhook_secret = secrets.token_hex(24)
        webhook_url = f"{_backend_base(settings)}/github/webhook"
        ok = await register_webhook(token, owner, repo_name, webhook_url, webhook_secret)
        if ok:
            db.table("github_connections").update({"webhook_secret": webhook_secret}).eq("project_id", project_id).execute()

    redirect_url = f"{settings.frontend_url.rstrip('/')}/projects/{project_id}?github_connected=1"
    return Response(status_code=302, headers={"Location": redirect_url})


# ─── Repository listing ───────────────────────────────────────────────────────

@router.get("/repos")
async def github_list_repos(project_id: str = "", team_id: str = ""):
    """Return all repos accessible by the stored token (team or project level)."""
    db = get_supabase()
    token: str | None = None

    if team_id:
        token = await get_team_token(team_id)
    elif project_id:
        # Try project token first, then team token
        conn_resp = (
            db.table("github_connections")
            .select("github_token,project_id")
            .eq("project_id", project_id)
            .execute()
        )
        if conn_resp.data:
            token = conn_resp.data[0].get("github_token") or None
        if not token:
            from app.services.github_service import _get_team_token_for_project
            t = await _get_team_token_for_project(project_id, db)
            token = t or None

    if not token:
        raise HTTPException(400, "GitHub not connected.")
    repos = await list_repos(token)
    return {"repos": repos}


# ─── Team-level status / disconnect ──────────────────────────────────────────

@router.get("/team-status")
def github_team_status(team_id: str):
    """Check if a team has connected GitHub."""
    db = get_supabase()
    resp = (
        db.table("team_github_tokens")
        .select("github_user_login")
        .eq("team_id", team_id)
        .execute()
    )
    if not resp.data:
        return {"connected": False}
    return {"connected": True, "github_user": resp.data[0].get("github_user_login")}


@router.delete("/team-disconnect")
def github_team_disconnect(team_id: str):
    """Disconnect GitHub from a team. Projects lose the shared token."""
    db = get_supabase()
    db.table("team_github_tokens").delete().eq("team_id", team_id).execute()
    return {"team_id": team_id, "connected": False}


# ─── Status / connect / change / disconnect ───────────────────────────────────

@router.get("/status")
def github_status(project_id: str):
    db = get_supabase()
    resp = db.table("github_connections").select("repo_owner,repo_name,github_user_login").eq("project_id", project_id).execute()
    if not resp.data or not resp.data[0].get("repo_name"):
        return {"connected": False}
    row = resp.data[0]
    return {
        "connected": True,
        "repo": f"{row['repo_owner']}/{row['repo_name']}",
        "github_user": row.get("github_user_login"),
    }


@router.post("/connect")
async def github_connect(project_id: str, body: ConnectBody):
    """PAT fallback — connect with a personal access token."""
    token = body.token.strip()
    repo = body.repo.strip()
    if not token:
        raise HTTPException(400, "GitHub token is required")
    if "/" not in repo:
        raise HTTPException(400, "repo must be owner/repo-name")
    owner, name = repo.split("/", 1)
    if not owner or not name:
        raise HTTPException(400, "repo must be owner/repo-name")
    login = await verify_token(token, owner, name)
    if login is None:
        raise HTTPException(400, "Cannot access that repo. Check the token has repo scope and the repo name is correct.")
    db = get_supabase()
    existing = db.table("github_connections").select("id").eq("project_id", project_id).execute()
    if existing.data:
        db.table("github_connections").update({
            "github_token": token,
            "repo_owner": owner,
            "repo_name": name,
            "github_user_login": login,
        }).eq("project_id", project_id).execute()
    else:
        db.table("github_connections").insert({
            "project_id": project_id,
            "github_token": token,
            "repo_owner": owner,
            "repo_name": name,
            "github_user_login": login,
        }).execute()

    # Attempt webhook registration
    settings = get_settings()
    webhook_secret = secrets.token_hex(24)
    webhook_url = f"{_backend_base(settings)}/github/webhook"
    ok = await register_webhook(token, owner, name, webhook_url, webhook_secret)
    if ok:
        db.table("github_connections").update({"webhook_secret": webhook_secret}).eq("project_id", project_id).execute()

    return {"connected": True, "repo": repo, "github_user": login}


@router.patch("/repo")
async def set_github_repo(project_id: str, body: RepoBody):
    repo = body.repo.strip()
    if "/" not in repo:
        raise HTTPException(400, "repo must be owner/repo-name")
    owner, name = repo.split("/", 1)
    db = get_supabase()

    # Resolve the token to use (project-level or team-level)
    conn = db.table("github_connections").select("github_token").eq("project_id", project_id).execute()
    token: str = ""
    if conn.data:
        token = conn.data[0].get("github_token") or ""
    if not token:
        from app.services.github_service import _get_team_token_for_project
        token = await _get_team_token_for_project(project_id, db)

    # Upsert the repo selection
    if conn.data:
        db.table("github_connections").update({"repo_owner": owner, "repo_name": name}).eq("project_id", project_id).execute()
    else:
        db.table("github_connections").insert({
            "project_id": project_id,
            "github_token": "",
            "repo_owner": owner,
            "repo_name": name,
        }).execute()

    # Register webhook if we have a token
    if token:
        settings = get_settings()
        webhook_secret = secrets.token_hex(24)
        webhook_url = f"{_backend_base(settings)}/github/webhook"
        ok = await register_webhook(token, owner, name, webhook_url, webhook_secret)
        if ok:
            db.table("github_connections").update({"webhook_secret": webhook_secret}).eq("project_id", project_id).execute()

    return {"project_id": project_id, "repo": repo}


@router.delete("/disconnect")
def github_disconnect(project_id: str):
    db = get_supabase()
    db.table("github_connections").delete().eq("project_id", project_id).execute()
    return {"project_id": project_id, "connected": False}


# ─── Webhook receiver ─────────────────────────────────────────────────────────

@router.post("/webhook")
async def github_webhook(request: Request):
    """
    Receive GitHub webhook events.
    Handles pull_request events to sync task PR state.
    """
    body = await request.body()
    event = request.headers.get("X-GitHub-Event", "")
    signature = request.headers.get("X-Hub-Signature-256", "")

    if event == "ping":
        return {"ok": True}

    if event != "pull_request":
        return {"ok": True, "skipped": True}

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON payload")

    action = payload.get("action", "")
    pr = payload.get("pull_request", {})
    repo_info = payload.get("repository", {})
    repo_owner = repo_info.get("owner", {}).get("login", "")
    repo_name = repo_info.get("name", "")
    pr_number = pr.get("number")
    pr_url = pr.get("html_url", "")
    merged = pr.get("merged", False)

    db = get_supabase()

    # Look up the connection by repo to validate the signature
    conn_resp = (
        db.table("github_connections")
        .select("id,project_id,webhook_secret")
        .eq("repo_owner", repo_owner)
        .eq("repo_name", repo_name)
        .execute()
    )
    if not conn_resp.data:
        # Unknown repo — still return 200 to avoid GitHub marking webhook as failed
        return {"ok": True, "skipped": True}

    conn = conn_resp.data[0]
    webhook_secret = conn.get("webhook_secret") or ""
    if webhook_secret and not verify_webhook_signature(body, signature, webhook_secret):
        raise HTTPException(403, "Invalid webhook signature")

    project_id = conn["project_id"]

    # Find the task that owns this PR
    task_resp = (
        db.table("tasks")
        .select("id,status")
        .eq("project_id", project_id)
        .eq("github_pr_number", pr_number)
        .execute()
    )
    if not task_resp.data:
        return {"ok": True, "skipped": True}

    task = task_resp.data[0]
    task_id = task["id"]

    if action == "opened" or action == "reopened":
        db.table("tasks").update({
            "github_pr_state": "open",
            "github_pr_url": pr_url,
        }).eq("id", task_id).execute()

    elif action == "closed":
        if merged:
            db.table("tasks").update({
                "github_pr_state": "merged",
                "status": "done",
            }).eq("id", task_id).execute()
        else:
            db.table("tasks").update({
                "github_pr_state": "closed",
            }).eq("id", task_id).execute()

    return {"ok": True}

