from __future__ import annotations

from fastapi import APIRouter, HTTPException
from app.db import get_supabase

router = APIRouter()


@router.get("/{actor_id}")
def get_actor(actor_id: str):
    db = get_supabase()
    resp = db.table("actors").select("*").eq("id", actor_id).single().execute()
    if not resp.data:
        raise HTTPException(404, "Actor not found")
    return resp.data


@router.patch("/{actor_id}")
def update_actor(actor_id: str, body: dict):
    db = get_supabase()
    allowed_fields = {"name", "role", "model", "capabilities", "avatar_url"}
    update = {k: v for k, v in body.items() if k in allowed_fields}
    if not update:
        raise HTTPException(400, "No valid fields to update")
    db.table("actors").update(update).eq("id", actor_id).execute()
    return {"actor_id": actor_id, **update}


@router.delete("/{actor_id}", status_code=204)
def delete_actor(actor_id: str):
    db = get_supabase()
    actor = db.table("actors").select("id").eq("id", actor_id).single().execute()
    if not actor.data:
        raise HTTPException(404, "Actor not found")
    db.table("actors").delete().eq("id", actor_id).execute()
