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

    org = db.table("organizations").select("id,name").eq("id", org_id).single().execute()
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

    existing_user = next((u for u in users if (_user_email(u) or "").lower() == email), None)

    # Only treat as existing if email is confirmed — unconfirmed users (waiting for
    # verification) should go through the invite flow so they get a proper invite link.
    def _is_confirmed(user) -> bool:
        confirmed = getattr(user, "email_confirmed_at", None) or (
            user.get("email_confirmed_at") if isinstance(user, dict) else None
        )
        return bool(confirmed)

    existing_user_id = _user_id(existing_user) if (existing_user and _is_confirmed(existing_user)) else None
    if existing_user_id:
        row = {"org_id": org_id, "user_id": existing_user_id, "role": body.role}
        db.table("org_members").upsert(row).execute()
        try:
            send_added_to_org_email(
                to_email=email,
                org_name=org.data["name"],
                inviter_email=inviter_email,
                role=body.role,
                frontend_url=settings.frontend_url,
            )
        except Exception:
            pass  # Non-blocking — member was added regardless
        return {
            "status": "added_existing_user",
            "email": email,
            "invited_by_email": inviter_email,
            "organization": org.data["name"],
            **row,
        }

    try:
        db.table("org_invites").upsert({
            "org_id": org_id,
            "email": email,
            "role": body.role,
            "invited_by_user_id": body.invited_by_user_id,
            "invited_by_email": inviter_email,
            "status": "pending",
        }).execute()
    except Exception:
        # Migration may not be applied yet; continue with invite email flow.
        pass

    invite_error: str | None = None

    if settings.postmark_enabled:
        # Use generate_link + Postmark: bypasses Supabase email rate limits entirely.
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
                    "redirect_to": f"{settings.frontend_url.rstrip('/')}/login",
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
                invite_error = "already_exists"
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
                    "redirect_to": f"{settings.frontend_url.rstrip('/')}/login",
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
    elif invite_error == "already_exists":
        status = "added_existing_user"

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


@router.post("/accept-invites")
def accept_pending_invites(body: AcceptInvitesBody):
    db = get_supabase()

    email = body.email.strip().lower()
    pending = (
        db.table("org_invites")
        .select("id,org_id,role")
        .eq("email", email)
        .eq("status", "pending")
        .execute()
    )
    rows = pending.data or []

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


@router.delete("/{org_id}/members/{user_id}", status_code=204)
def remove_member(org_id: str, user_id: str):
    db = get_supabase()
    db.table("org_members").delete().eq("org_id", org_id).eq("user_id", user_id).execute()
