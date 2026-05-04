from __future__ import annotations

from fastapi import APIRouter, HTTPException
from app.db import get_supabase

router = APIRouter()


def _mask_actor(actor: dict) -> dict:
    """Never expose agent_api_key or extra_env values in API responses."""
    result = {**actor}
    if "agent_api_key" in result:
        result["agent_api_key"] = "***" if result["agent_api_key"] else None
    if isinstance(result.get("extra_env"), dict):
        result["extra_env"] = {k: "***" for k in result["extra_env"]}
    return result


@router.get("/{actor_id}")
def get_actor(actor_id: str):
    db = get_supabase()
    resp = db.table("actors").select("*").eq("id", actor_id).single().execute()
    if not resp.data:
        raise HTTPException(404, "Actor not found")
    return _mask_actor(resp.data)


@router.patch("/{actor_id}")
def update_actor(actor_id: str, body: dict):
    db = get_supabase()
    allowed_fields = {
        "name",
        "role",
        "type",
        "model",
        "capabilities",
        "avatar_url",
        "user_id",
        "webhook_url",
        "agent_api_key",
        "docker_image",
        "extra_env",
    }
    # company_agent_id: resolve template and copy dispatch fields server-side
    company_agent_id = body.get("company_agent_id")
    update = {k: v for k, v in body.items() if k in allowed_fields}
    if company_agent_id is not None:
        if company_agent_id:
            ca_resp = db.table("company_agents").select("*").eq("id", company_agent_id).single().execute()
            if not ca_resp.data:
                raise HTTPException(404, "Company agent not found")
            ca = ca_resp.data
            update["webhook_url"] = ca.get("webhook_url")
            update["docker_image"] = ca.get("docker_image")
            update["agent_api_key"] = ca.get("agent_api_key")
            update["extra_env"] = ca.get("extra_env")
        else:
            # Clearing: remove all agent-specific fields
            update["webhook_url"] = None
            update["docker_image"] = None
            update["agent_api_key"] = None
            update["extra_env"] = None
    if not update:
        raise HTTPException(400, "No valid fields to update")
    db.table("actors").update(update).eq("id", actor_id).execute()
    return _mask_actor({"actor_id": actor_id, **update})


@router.delete("/{actor_id}", status_code=204)
def delete_actor(actor_id: str):
    db = get_supabase()
    actor = db.table("actors").select("id").eq("id", actor_id).single().execute()
    if not actor.data:
        raise HTTPException(404, "Actor not found")
    db.table("actors").delete().eq("id", actor_id).execute()
