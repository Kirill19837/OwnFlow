from __future__ import annotations

import re
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db import get_supabase

router = APIRouter(prefix="/companies", tags=["companies"])

AI_MODELS = [
    "gpt-4o", "gpt-4o-mini", "o3-mini",
    "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022",
]


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


class CompanyCreate(BaseModel):
    name: str
    owner_id: str
    default_ai_model: str = "gpt-4o"
    phone: Optional[str] = None


class TeamCreate(BaseModel):
    name: str
    owner_id: str
    default_ai_model: str = "gpt-4o"


@router.post("", status_code=201)
def create_company(body: CompanyCreate):
    """Create a company and auto-create a first team with the same name."""
    db = get_supabase()

    if body.default_ai_model not in AI_MODELS:
        raise HTTPException(400, f"model must be one of {AI_MODELS}")

    # Create company
    slug = _slug(body.name)
    if db.table("companies").select("id").eq("slug", slug).execute().data:
        slug = f"{slug}-{str(uuid.uuid4())[:6]}"
    company_id = str(uuid.uuid4())
    company_row = {"id": company_id, "name": body.name, "slug": slug, "owner_id": body.owner_id}
    if body.phone:
        company_row["phone"] = body.phone
    db.table("companies").insert(company_row).execute()
    db.table("company_members").insert({
        "company_id": company_id,
        "user_id": body.owner_id,
        "role": "owner",
    }).execute()

    # Auto-create first team with same name
    team_slug = f"{slug}-team"
    if db.table("organizations").select("id").eq("slug", team_slug).execute().data:
        team_slug = f"{team_slug}-{str(uuid.uuid4())[:6]}"
    team_id = str(uuid.uuid4())
    team_row = {
        "id": team_id,
        "name": body.name,
        "slug": team_slug,
        "owner_id": body.owner_id,
        "default_ai_model": body.default_ai_model,
        "company_id": company_id,
    }
    db.table("organizations").insert(team_row).execute()
    db.table("org_members").insert({
        "org_id": team_id,
        "user_id": body.owner_id,
        "role": "owner",
    }).execute()

    return {**company_row, "my_role": "owner", "default_team_id": team_id}


@router.get("/my")
def my_company(user_id: str):
    """Return the company this user belongs to, or null."""
    db = get_supabase()
    member = (
        db.table("company_members")
        .select("company_id, role")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not member.data:
        return None
    m = member.data[0]
    company = db.table("companies").select("*").eq("id", m["company_id"]).single().execute()
    if not company.data:
        return None
    return {**company.data, "my_role": m["role"]}


@router.get("/{company_id}/teams")
def list_teams(company_id: str, user_id: Optional[str] = None):
    """List teams within a company, optionally annotating with the user's role."""
    db = get_supabase()
    teams = db.table("organizations").select("*").eq("company_id", company_id).execute()
    result = teams.data or []

    if user_id and result:
        team_ids = [t["id"] for t in result]
        members = (
            db.table("org_members")
            .select("org_id, role")
            .eq("user_id", user_id)
            .in_("org_id", team_ids)
            .execute()
        )
        role_map = {m["org_id"]: m["role"] for m in (members.data or [])}
        for t in result:
            t["my_role"] = role_map.get(t["id"])

    return result


@router.post("/{company_id}/teams", status_code=201)
def create_team(company_id: str, body: TeamCreate):
    """Create a new team within a company."""
    db = get_supabase()

    if body.default_ai_model not in AI_MODELS:
        raise HTTPException(400, f"model must be one of {AI_MODELS}")

    company = db.table("companies").select("id").eq("id", company_id).single().execute()
    if not company.data:
        raise HTTPException(404, "Company not found")

    slug = _slug(body.name)
    if db.table("organizations").select("id").eq("slug", slug).execute().data:
        slug = f"{slug}-{str(uuid.uuid4())[:6]}"

    team_id = str(uuid.uuid4())
    row = {
        "id": team_id,
        "name": body.name,
        "slug": slug,
        "owner_id": body.owner_id,
        "default_ai_model": body.default_ai_model,
        "company_id": company_id,
    }
    db.table("organizations").insert(row).execute()
    db.table("org_members").insert({
        "org_id": team_id,
        "user_id": body.owner_id,
        "role": "owner",
    }).execute()
    return {**row, "my_role": "owner"}
