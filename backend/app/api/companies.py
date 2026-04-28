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

ROLE_IDS = {
    "owner":  "00000000-0000-0000-0000-000000000001",
    "admin":  "00000000-0000-0000-0000-000000000002",
    "member": "00000000-0000-0000-0000-000000000003",
}
ROLE_NAMES = {v: k for k, v in ROLE_IDS.items()}


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


class CompanyCreate(BaseModel):
    name: str
    owner_id: str
    default_ai_model: str = "gpt-4o"
    phone: Optional[str] = None
    password: Optional[str] = None
    full_name: Optional[str] = None


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

    if body.full_name is not None and len(body.full_name.strip()) < 4:
        raise HTTPException(400, "Full name must be at least 4 characters")
    if body.password is not None and len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")

    # Atomically set password + name BEFORE creating company rows.
    # This ensures profile is never half-saved if company creation fails.
    if body.password or body.full_name:
        user_update: dict = {}
        if body.password:
            user_update["password"] = body.password
        user_meta: dict = {"password_set": True} if body.password else {}
        if body.full_name and body.full_name.strip():
            user_meta["full_name"] = body.full_name.strip()
        if user_meta:
            user_update["user_metadata"] = user_meta
        try:
            db.auth.admin.update_user_by_id(body.owner_id, user_update)
        except Exception as exc:
            raise HTTPException(400, f"Failed to update profile: {exc}")

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
        "role": ROLE_IDS["owner"],
    }).execute()

    # Auto-create first team with same name
    team_slug = f"{slug}-team"
    if db.table("teams").select("id").eq("slug", team_slug).execute().data:
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
    db.table("teams").insert(team_row).execute()
    db.table("team_members").insert({
        "team_id": team_id,
        "user_id": body.owner_id,
        "role": ROLE_IDS["owner"],
    }).execute()

    # Mark the owner's onboarding as complete.
    from datetime import datetime, timezone
    _now = datetime.now(timezone.utc).isoformat()
    try:
        db.table("user_signups").upsert({
            "user_id": body.owner_id,
            "origin": "organic",
            "signup_status": "company_created",
            "completed_at": _now,
        }, on_conflict="user_id").execute()
    except Exception:
        pass  # Non-blocking

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
    return {**company.data, "my_role": ROLE_NAMES.get(m["role"], m["role"])}


@router.get("/{company_id}/teams")
def list_teams(company_id: str, user_id: Optional[str] = None):
    """List teams within a company the user is a member of."""
    db = get_supabase()

    if user_id:
        # Fetch only the teams this user belongs to within the company
        memberships = (
            db.table("team_members")
            .select("team_id, role")
            .eq("user_id", user_id)
            .execute()
        )
        member_team_ids = [m["team_id"] for m in (memberships.data or [])]
        if not member_team_ids:
            return []
        teams = (
            db.table("teams")
            .select("*")
            .eq("company_id", company_id)
            .in_("id", member_team_ids)
            .execute()
        )
        role_map = {m["team_id"]: ROLE_NAMES.get(m["role"], m["role"]) for m in (memberships.data or [])}
        result = teams.data or []
        for t in result:
            t["my_role"] = role_map.get(t["id"])
        return result

    # No user_id — return all teams without role annotation (admin/internal use)
    teams = db.table("teams").select("*").eq("company_id", company_id).execute()
    return teams.data or []


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
    if db.table("teams").select("id").eq("slug", slug).execute().data:
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
    db.table("teams").insert(row).execute()
    db.table("team_members").insert({
        "team_id": team_id,
        "user_id": body.owner_id,
        "role": ROLE_IDS["owner"],
    }).execute()
    return {**row, "my_role": "owner"}
