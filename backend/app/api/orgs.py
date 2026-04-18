from __future__ import annotations

from fastapi import APIRouter, HTTPException
from app.db import get_supabase
from pydantic import BaseModel
from typing import Optional
import uuid
import re

router = APIRouter()

AI_MODELS = [
    "gpt-4o", "gpt-4o-mini", "o3-mini",
    "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022",
]


class OrgCreate(BaseModel):
    name: str
    owner_id: str
    default_ai_model: str = "gpt-4o"


class OrgUpdate(BaseModel):
    name: Optional[str] = None
    default_ai_model: Optional[str] = None


class OrgInvite(BaseModel):
    user_id: str
    role: str = "member"


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


@router.post("", status_code=201)
async def create_org(body: OrgCreate):
    if body.default_ai_model not in AI_MODELS:
        raise HTTPException(400, f"model must be one of {AI_MODELS}")
    db = get_supabase()
    slug = _slug(body.name)
    existing = db.table("organizations").select("id").eq("slug", slug).execute()
    if existing.data:
        slug = f"{slug}-{str(uuid.uuid4())[:6]}"
    org_id = str(uuid.uuid4())
    row = {
        "id": org_id,
        "name": body.name,
        "slug": slug,
        "owner_id": body.owner_id,
        "default_ai_model": body.default_ai_model,
    }
    db.table("organizations").insert(row).execute()
    db.table("org_members").insert({
        "org_id": org_id,
        "user_id": body.owner_id,
        "role": "owner",
    }).execute()
    return {**row, "my_role": "owner"}


@router.get("/my")
async def my_orgs(user_id: str):
    db = get_supabase()
    members = db.table("org_members").select("org_id, role").eq("user_id", user_id).execute()
    items = members.data or []
    if not items:
        return []
    org_ids = [m["org_id"] for m in items]
    role_map = {m["org_id"]: m["role"] for m in items}
    orgs = db.table("organizations").select("*").in_("id", org_ids).execute()
    result = orgs.data or []
    for o in result:
        o["my_role"] = role_map.get(o["id"])
    return result


@router.get("/models")
async def list_models():
    return {"models": AI_MODELS}


@router.get("/{org_id}")
async def get_org(org_id: str):
    db = get_supabase()
    org = db.table("organizations").select("*").eq("id", org_id).single().execute()
    if not org.data:
        raise HTTPException(404, "Organization not found")
    members = db.table("org_members").select("*").eq("org_id", org_id).execute()
    return {**org.data, "members": members.data or []}


@router.patch("/{org_id}")
async def update_org(org_id: str, body: OrgUpdate):
    db = get_supabase()
    if body.default_ai_model and body.default_ai_model not in AI_MODELS:
        raise HTTPException(400, f"model must be one of {AI_MODELS}")
    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update:
        raise HTTPException(400, "No valid fields to update")
    db.table("organizations").update(update).eq("id", org_id).execute()
    return {"org_id": org_id, **update}


@router.post("/{org_id}/members", status_code=201)
async def invite_member(org_id: str, body: OrgInvite):
    db = get_supabase()
    if body.role not in ("owner", "admin", "member"):
        raise HTTPException(400, "role must be owner, admin, or member")
    row = {"org_id": org_id, "user_id": body.user_id, "role": body.role}
    db.table("org_members").upsert(row).execute()
    return row


@router.delete("/{org_id}/members/{user_id}", status_code=204)
async def remove_member(org_id: str, user_id: str):
    db = get_supabase()
    db.table("org_members").delete().eq("org_id", org_id).eq("user_id", user_id).execute()
