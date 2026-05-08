from __future__ import annotations

import random
import uuid

from fastapi import APIRouter, HTTPException, Depends
from app.db import get_supabase
from app.models import ActorCreate
from app.auth_deps import current_user_id

router = APIRouter()
project_router = APIRouter()

# Default AI actor set used by auto-fill (role → default model)
_AUTO_FILL_ACTORS = [
    ("AI Project Manager",  "ai"),
    ("Architect",           "ai"),
    ("Lead Developer",      "ai"),
    ("Frontend Developer",  "ai"),
    ("Backend Developer",   "ai"),
    ("QA Automation Lead",  "ai"),
]

# Role-based default docker image dispatch
# Maps role names (case-insensitive) to their dedicated agent container
_ROLE_TO_DOCKER_IMAGE = {
    "ui/ux designer": "ownflow-figma-agent:latest",
    "designer": "ownflow-figma-agent:latest",
}

_AI_NAMES = [
    "Aria", "Nova", "Orion", "Sage", "Atlas", "Echo", "Lyra", "Zara",
    "Cleo", "Finn", "Mira", "Denis", "Skye", "Theo", "Wren", "Zion",
]

def _get_default_docker_image_for_role(role: str) -> str | None:
    """Resolve default docker image for a given role (case-insensitive lookup)."""
    if not role:
        return None
    role_lower = role.strip().lower()
    return _ROLE_TO_DOCKER_IMAGE.get(role_lower)


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
def update_actor(actor_id: str, body: dict, _caller_id: str = Depends(current_user_id)):
    db = get_supabase()

    # Verify that the actor belongs to a project/team the user has access to.
    # This prevents cross-tenant leakage when fetching existing extra_env values.
    actor_resp = db.table("actors").select("project_id").eq("id", actor_id).single().execute()
    if not actor_resp.data:
        raise HTTPException(404, "Actor not found")
    project_id = actor_resp.data.get("project_id")
    if project_id:
        # Verify user is a member of the team that owns this project
        proj_resp = db.table("projects").select("team_id").eq("id", project_id).single().execute()
        team_id = (proj_resp.data or {}).get("team_id")
        if team_id:
            member_resp = db.table("team_members").select("user_id").eq("team_id", team_id).eq("user_id", _caller_id).single().execute()
            if not member_resp.data:
                raise HTTPException(403, "You do not have access to this actor")

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
    # company_agent_id: resolve template and copy dispatch fields server-side.
    # Scope the lookup to the actor's own company to prevent cross-tenant leakage.
    company_agent_id = body.get("company_agent_id")
    update = {k: v for k, v in body.items() if k in allowed_fields}
    if "extra_env" in update and isinstance(update["extra_env"], dict):
        incoming: dict = update["extra_env"]
        # Only fetch existing values when a masked sentinel is present and merge is needed.
        # Safe: actor belongs to authorized user's team (verified above).
        needs_merge = any(value == "***" for value in incoming.values())
        existing: dict = {}
        if needs_merge:
            existing_resp = db.table("actors").select("extra_env").eq("id", actor_id).single().execute()
            existing = (existing_resp.data or {}).get("extra_env") or {}

        merged = {}
        for key, value in incoming.items():
            k = key.strip()
            if not k:
                continue
            if value == "***":
                if k in existing:
                    merged[k] = existing[k]
            else:
                merged[k] = value
        update["extra_env"] = merged if merged else None
    if company_agent_id is not None:
        if company_agent_id:
            # Resolve actor → project → team → company
            actor_resp = db.table("actors").select("project_id").eq("id", actor_id).single().execute()
            project_id = (actor_resp.data or {}).get("project_id")
            company_id = None
            if project_id:
                proj_resp = db.table("projects").select("team_id").eq("id", project_id).single().execute()
                team_id = (proj_resp.data or {}).get("team_id")
                if team_id:
                    team_resp = db.table("teams").select("company_id").eq("id", team_id).single().execute()
                    company_id = (team_resp.data or {}).get("company_id")
            ca_resp = (
                db.table("company_agents")
                .select("*")
                .eq("id", company_agent_id)
                .single()
                .execute()
            )
            ca = ca_resp.data
            if not ca:
                raise HTTPException(404, "Company agent not found")
            if not company_id or ca.get("company_id") != company_id:
                raise HTTPException(403, "Company agent does not belong to this actor's company")
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


@project_router.post("/{project_id}/actors", status_code=201)
def add_actor(project_id: str, body: ActorCreate):
    db = get_supabase()
    row = {
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        "name": body.name,
        "type": body.type,
        "role": body.role,
        "model": body.model,
        "capabilities": body.capabilities,
        "avatar_url": body.avatar_url,
    }
    if body.user_id:
        row["user_id"] = body.user_id
    # If a company agent template is specified, resolve and copy its dispatch fields.
    # Scope the lookup to the project's own company to prevent cross-tenant leakage.
    if body.company_agent_id:
        # Resolve project's company via team
        proj_resp = db.table("projects").select("team_id").eq("id", project_id).single().execute()
        team_id = (proj_resp.data or {}).get("team_id")
        company_id = None
        if team_id:
            team_resp = db.table("teams").select("company_id").eq("id", team_id).single().execute()
            company_id = (team_resp.data or {}).get("company_id")
        ca_resp = (
            db.table("company_agents")
            .select("*")
            .eq("id", body.company_agent_id)
            .single()
            .execute()
        )
        ca = ca_resp.data
        if not ca:
            raise HTTPException(404, "Company agent not found")
        if not company_id or ca.get("company_id") != company_id:
            raise HTTPException(403, "Company agent does not belong to this project's company")
        if ca.get("webhook_url"):
            row["webhook_url"] = ca["webhook_url"]
        if ca.get("docker_image"):
            row["docker_image"] = ca["docker_image"]
        if ca.get("agent_api_key"):
            row["agent_api_key"] = ca["agent_api_key"]
        if ca.get("extra_env"):
            row["extra_env"] = ca["extra_env"]
    else:
        if body.webhook_url:
            row["webhook_url"] = body.webhook_url
        if body.agent_api_key:
            row["agent_api_key"] = body.agent_api_key
        if body.docker_image:
            row["docker_image"] = body.docker_image
        if body.extra_env:
            row["extra_env"] = body.extra_env

    # Auto-assign docker image based on role if not explicitly provided
    if "docker_image" not in row or not row["docker_image"]:
        default_image = _get_default_docker_image_for_role(body.role)
        if default_image:
            row["docker_image"] = default_image

    db.table("actors").insert(row).execute()
    return _mask_actor(row)


@project_router.post("/{project_id}/actors/auto-fill", status_code=200)
def auto_fill_actors(project_id: str, body: dict):
    """Replace all AI actors with the standard default set. Human actors are preserved."""
    db = get_supabase()
    ai_model = body.get("ai_model") or "gpt-4o"

    # Fetch project to verify it exists
    proj = db.table("projects").select("id").eq("id", project_id).single().execute()
    if not proj.data:
        raise HTTPException(404, "Project not found")

    # Delete existing AI actors only
    db.table("actors").delete().eq("project_id", project_id).eq("type", "ai").execute()

    # Collect roles already covered by human actors so we don't add AI duplicates
    humans_resp = db.table("actors").select("role").eq("project_id", project_id).eq("type", "human").execute()
    human_roles = {(r.get("role") or "").strip().lower() for r in (humans_resp.data or [])}

    # Insert standard AI actor set, skipping roles already covered by a human
    name_pool = _AI_NAMES.copy()
    random.shuffle(name_pool)
    rows = []
    name_idx = 0
    for role, atype in _AUTO_FILL_ACTORS:
        if role.strip().lower() in human_roles:
            continue  # human already covers this role
        actor_row = {
            "id": str(uuid.uuid4()),
            "project_id": project_id,
            "name": name_pool[name_idx % len(name_pool)],
            "type": atype,
            "role": role,
            "model": ai_model,
            "capabilities": [],
        }
        # Auto-assign docker image based on role
        default_image = _get_default_docker_image_for_role(role)
        if default_image:
            actor_row["docker_image"] = default_image
        rows.append(actor_row)
        name_idx += 1
    db.table("actors").insert(rows).execute()
    return {"created": len(rows), "actors": [_mask_actor(r) for r in rows]}
