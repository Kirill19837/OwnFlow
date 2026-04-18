"""GitHub per-project integration endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.db import get_supabase
from app.services.github_service import verify_token

router = APIRouter()


class ConnectBody(BaseModel):
    token: str
    repo: str


class RepoBody(BaseModel):
    repo: str


@router.post("/connect")
async def github_connect(project_id: str, body: ConnectBody):
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
        db.table("github_connections").update({"github_token": token, "repo_owner": owner, "repo_name": name}).eq("project_id", project_id).execute()
    else:
        db.table("github_connections").insert({"project_id": project_id, "github_token": token, "repo_owner": owner, "repo_name": name}).execute()
    return {"connected": True, "repo": repo, "github_user": login}


@router.get("/status")
async def github_status(project_id: str):
    db = get_supabase()
    resp = db.table("github_connections").select("repo_owner,repo_name").eq("project_id", project_id).execute()
    if not resp.data or not resp.data[0].get("repo_name"):
        return {"connected": False}
    row = resp.data[0]
    return {"connected": True, "repo": f"{row['repo_owner']}/{row['repo_name']}"}


@router.patch("/repo")
async def set_github_repo(project_id: str, body: RepoBody):
    repo = body.repo.strip()
    if "/" not in repo:
        raise HTTPException(400, "repo must be owner/repo-name")
    owner, name = repo.split("/", 1)
    db = get_supabase()
    existing = db.table("github_connections").select("id").eq("project_id", project_id).execute()
    if not existing.data:
        raise HTTPException(400, "GitHub not connected for this project")
    db.table("github_connections").update({"repo_owner": owner, "repo_name": name}).eq("project_id", project_id).execute()
    return {"project_id": project_id, "repo": repo}


@router.delete("/disconnect")
async def github_disconnect(project_id: str):
    db = get_supabase()
    db.table("github_connections").delete().eq("project_id", project_id).execute()
    return {"project_id": project_id, "connected": False}
