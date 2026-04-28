from __future__ import annotations

from fastapi import APIRouter, HTTPException
from app.auth_deps import current_user_id
from app.db import get_supabase
from fastapi import Depends
from pydantic import BaseModel
from typing import Optional

router = APIRouter()


@router.get("")
def list_skills(category: Optional[str] = None):
    """Return all skills, optionally filtered by category."""
    db = get_supabase()
    query = db.table("skills").select("*").order("category").order("name")
    if category:
        query = query.eq("category", category)
    resp = query.execute()
    return resp.data or []


@router.get("/categories")
def list_categories():
    """Return the distinct skill categories in display order."""
    db = get_supabase()
    resp = db.table("skills").select("category").execute()
    seen: list[str] = []
    for row in (resp.data or []):
        cat = row["category"]
        if cat not in seen:
            seen.append(cat)
    return seen


@router.get("/user/{user_id}")
def get_user_skills(user_id: str):
    """Return the skill objects selected by a user."""
    db = get_supabase()
    resp = (
        db.table("user_skills")
        .select("skill_id, skills(id, name, category, description, actor_type)")
        .eq("user_id", user_id)
        .execute()
    )
    return [row["skills"] for row in (resp.data or []) if row.get("skills")]


class SetSkillsBody(BaseModel):
    user_id: str
    skill_ids: list[str]


@router.put("/user")
def set_user_skills(body: SetSkillsBody, caller_id: str = Depends(current_user_id)):
    """Replace the caller's skill selections (caller can only update their own skills)."""
    if caller_id != body.user_id:
        raise HTTPException(403, "Cannot update another user's skills")
    if len(body.skill_ids) > 10:
        raise HTTPException(400, "Cannot select more than 10 skills")
    db = get_supabase()
    # Delete existing then insert new (simple replace)
    db.table("user_skills").delete().eq("user_id", body.user_id).execute()
    if body.skill_ids:
        rows = [{"user_id": body.user_id, "skill_id": sid} for sid in body.skill_ids]
        db.table("user_skills").insert(rows).execute()
    return {"user_id": body.user_id, "skill_ids": body.skill_ids}
