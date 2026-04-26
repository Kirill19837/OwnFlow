from __future__ import annotations

from fastapi import APIRouter, HTTPException
from app.config import get_settings
from app.db import get_supabase
from app.email import send_invite_email, send_added_to_org_email
from pydantic import BaseModel
from typing import Optional
import uuid
import re
from datetime import datetime, timezone

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


class OrgEmailInvite(BaseModel):
    email: str
    role: str = "member"
    invited_by_user_id: str


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _is_valid_email(email: str) -> bool:
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email))


def _extract_auth_users(list_users_resp) -> list:
    # supabase-py v2 returns a plain list directly from list_users().
    if isinstance(list_users_resp, list):
        return list_users_resp
    users = getattr(list_users_resp, "users", None)
    if users is not None:
        return users
    if isinstance(list_users_resp, dict):
        return list_users_resp.get("users", [])
    return []


def _user_id(user) -> Optional[str]:
    user_id = user.get("id") if isinstance(user, dict) else getattr(user, "id", None)
    return str(user_id) if user_id else None


def _user_email(user) -> Optional[str]:
    return user.get("email") if isinstance(user, dict) else getattr(user, "email", None)


def _extract_user_id(invite_resp) -> Optional[str]:
    user = getattr(invite_resp, "user", None)
    if user is not None:
        user_id = getattr(user, "id", None)
        if user_id:
            return str(user_id)
    if isinstance(invite_resp, dict):
        user_dict = invite_resp.get("user") or {}
        if isinstance(user_dict, dict) and user_dict.get("id"):
            return str(user_dict["id"])
    return None


@router.post("", status_code=201)
def create_org(body: OrgCreate):
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
    if body.company_id:
        row["company_id"] = body.company_id
    db.table("organizations").insert(row).execute()
    db.table("org_members").insert({
        "org_id": org_id,
        "user_id": body.owner_id,
        "role": "owner",
    }).execute()
    return {**row, "my_role": "owner"}


@router.get("/my")
def my_orgs(user_id: str):
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
def list_models():
    return {"models": AI_MODELS}


@router.get("/{org_id}")
def get_org(org_id: str):
    db = get_supabase()
    org = db.table("organizations").select("*").eq("id", org_id).single().execute()
    if not org.data:
        raise HTTPException(404, "Organization not found")
    members_resp = db.table("org_members").select("*").eq("org_id", org_id).execute()
    members = members_resp.data or []

    if members:
        users = _extract_auth_users(db.auth.admin.list_users())
        email_by_user_id = {
            uid: (_user_email(u) or "")
            for u in users
            for uid in [_user_id(u)]
            if uid
        }
        for member in members:
            member["email"] = email_by_user_id.get(str(member["user_id"]))

    pending_invites = []
    try:
        pending_resp = (
            db.table("org_invites")
            .select("id,email,role,invited_by_email,status,invited_at")
            .eq("org_id", org_id)
            .eq("status", "pending")
            .order("invited_at", desc=True)
            .execute()
        )
        pending_invites = pending_resp.data or []
    except Exception:
        # Keep org settings working if migration has not been applied yet.
        pending_invites = []

    return {**org.data, "members": members, "pending_invites": pending_invites}


@router.patch("/{org_id}")
def update_org(org_id: str, body: OrgUpdate):
    db = get_supabase()
    if body.default_ai_model and body.default_ai_model not in AI_MODELS:
        raise HTTPException(400, f"model must be one of {AI_MODELS}")
    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update:
        raise HTTPException(400, "No valid fields to update")
    db.table("organizations").update(update).eq("id", org_id).execute()
    return {"org_id": org_id, **update}


@router.post("/{org_id}/members", status_code=201)
def invite_member(org_id: str, body: OrgInvite):
    db = get_supabase()
    if body.role not in ("owner", "admin", "member"):
        raise HTTPException(400, "role must be owner, admin, or member")
    row = {"org_id": org_id, "user_id": body.user_id, "role": body.role}
    db.table("org_members").upsert(row).execute()
    return row


@router.post("/{org_id}/invites", status_code=201)
def invite_member_by_email(org_id: str, body: OrgEmailInvite):
    db = get_supabase()
    settings = get_settings()

    if body.role not in ("owner", "admin", "member"):
        raise HTTPException(400, "role must be owner, admin, or member")

    email = body.email.strip().lower()
    if not _is_valid_email(email):
        raise HTTPException(400, "Invalid email")

    org = db.table("organizations").select("id,name,company_id").eq("id", org_id).single().execute()
    if not org.data:
        raise HTTPException(404, "Organization not found")

    inviter_member = (
        db.table("org_members")
        .select("user_id")
        .eq("org_id", org_id)
        .eq("user_id", body.invited_by_user_id)
        .limit(1)
        .execute()
    )
    if not inviter_member.data:
        raise HTTPException(403, "Only organization members can invite")

    users_resp = db.auth.admin.list_users()
    users = _extract_auth_users(users_resp)
    inviter_user = next((u for u in users if _user_id(u) == body.invited_by_user_id), None)
    inviter_email = (_user_email(inviter_user) or "Unknown").strip()

    # Always use the pending invite flow — even for confirmed existing users.
    # They will be added to the org when they next log in and accept-invites runs.
    # This avoids adding users to teams without their knowledge.

    try:
        db.table("org_invites").upsert({
            "org_id": org_id,
            "email": email,
            "role": body.role,
            "invited_by_user_id": body.invited_by_user_id,
            "invited_by_email": inviter_email,
            "status": "pending",
            "company_id": (org.data or {}).get("company_id"),
        }).execute()
    except Exception:
        # Migration may not be applied yet; continue with invite email flow.
        pass

    invite_error: str | None = None

    if settings.postmark_enabled:
        # Use generate_link + Postmark: bypasses Supabase email rate limits entirely.
        # For confirmed existing users, generate_link(type=invite) fails — send a
        # login notification email instead so they know to log in and accept.
        try:
            link_resp = db.auth.admin.generate_link({
                "type": "invite",
                "email": email,
                "options": {
                    "data": {
                        "org_id": org_id,
                        "org_role": body.role,
                        "org_name": org.data["name"],
                        "invited_by_email": inviter_email,
                    },
                    "redirect_to": f"{settings.frontend_url.rstrip('/')}/login?invite_org={org_id}&link_type=join_company",
                },
            })
            action_link = (
                getattr(link_resp, "action_link", None)
                or (link_resp.properties.action_link if hasattr(link_resp, "properties") else None)
            )
            send_invite_email(
                to_email=email,
                invite_url=action_link or f"{settings.frontend_url}/login",
                org_name=org.data["name"],
                inviter_email=inviter_email,
                role=body.role,
            )
        except Exception as exc:
            msg = str(exc).lower()
            if "already registered" in msg or "already been invited" in msg:
                # User has a confirmed account — send a login notification instead
                login_url = f"{settings.frontend_url.rstrip('/')}/login?invite_org={org_id}&link_type=join_company"
                try:
                    send_added_to_org_email(
                        to_email=email,
                        org_name=org.data["name"],
                        inviter_email=inviter_email,
                        role=body.role,
                        frontend_url=login_url,
                    )
                except Exception:
                    pass  # Non-blocking
            else:
                raise HTTPException(400, f"Failed to send invite: {exc}")
    else:
        # Fallback: Supabase built-in mailer (subject to rate limits on free tier).
        try:
            db.auth.admin.invite_user_by_email(
                email,
                {
                    "data": {
                        "org_id": org_id,
                        "org_role": body.role,
                        "org_name": org.data["name"],
                        "invited_by_email": inviter_email,
                    },
                    "redirect_to": f"{settings.frontend_url.rstrip('/')}/login?invite_org={org_id}&link_type=join_company",
                },
            )
        except Exception as exc:
            msg = str(exc).lower()
            if "rate limit" in msg:
                invite_error = "rate_limit"
            elif "already registered" in msg or "already been invited" in msg:
                invite_error = "already_exists"
            else:
                raise HTTPException(400, f"Failed to send invite: {exc}")
    # Do NOT add to org_members yet — user hasn't confirmed the invite.
    # They will be added when they log in and accept-invites is called.

    status = "invite_sent"
    if invite_error == "rate_limit":
        status = "invite_queued"

    return {
        "status": status,
        "email": email,
        "org_id": org_id,
        "role": body.role,
        "organization": org.data["name"],
        "invited_by_email": inviter_email,
    }


class AcceptInvitesBody(BaseModel):
    user_id: str
    email: str
    org_id: Optional[str] = None  # If provided, only accept this specific org's invite


@router.post("/accept-invites")
def accept_pending_invites(body: AcceptInvitesBody):
    db = get_supabase()

    email = body.email.strip().lower()
    query = (
        db.table("org_invites")
        .select("id,org_id,role")
        .eq("email", email)
        .eq("status", "pending")
    )
    if body.org_id:
        query = query.eq("org_id", body.org_id)
    pending = query.execute()
    rows = pending.data or []

    if not rows:
        return {"accepted": 0, "org_ids": []}

    # Look up company for the target team(s)
    target_org_ids = [r["org_id"] for r in rows]
    teams = db.table("organizations").select("id,company_id").in_("id", target_org_ids).execute()
    company_ids = list({t["company_id"] for t in (teams.data or []) if t.get("company_id")})

    if company_ids:
        target_company_id = company_ids[0]
        # One company at a time: remove from all OTHER companies' teams + memberships
        other_memberships = (
            db.table("company_members")
            .select("company_id")
            .eq("user_id", body.user_id)
            .neq("company_id", target_company_id)
            .execute()
        )
        for cm in (other_memberships.data or []):
            old_cid = cm["company_id"]
            old_teams = db.table("organizations").select("id").eq("company_id", old_cid).execute()
            for ot in (old_teams.data or []):
                db.table("org_members").delete().eq("user_id", body.user_id).eq("org_id", ot["id"]).execute()
            db.table("company_members").delete().eq("user_id", body.user_id).eq("company_id", old_cid).execute()
        # Join the target company
        db.table("company_members").upsert({
            "company_id": target_company_id,
            "user_id": body.user_id,
            "role": "member",
        }).execute()
    else:
        # Legacy: teams without company_id — evict from all current teams before joining
        db.table("org_members").delete().eq("user_id", body.user_id).execute()

    accepted_org_ids: list[str] = []
    for row in rows:
        db.table("org_members").upsert({
            "org_id": row["org_id"],
            "user_id": body.user_id,
            "role": row["role"],
        }).execute()
        db.table("org_invites").update({
            "status": "accepted",
            "accepted_user_id": body.user_id,
            "accepted_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", row["id"]).execute()
        accepted_org_ids.append(row["org_id"])

    return {"accepted": len(accepted_org_ids), "org_ids": accepted_org_ids}


@router.delete("/{org_id}", status_code=204)
def delete_org(org_id: str):
    db = get_supabase()
    # Remove all members and invites first, then the org
    db.table("org_members").delete().eq("org_id", org_id).execute()
    db.table("org_invites").delete().eq("org_id", org_id).execute()
    db.table("organizations").delete().eq("id", org_id).execute()


@router.delete("/{org_id}/members/{user_id}", status_code=204)
def remove_member(org_id: str, user_id: str):
    db = get_supabase()
    db.table("org_members").delete().eq("org_id", org_id).eq("user_id", user_id).execute()
