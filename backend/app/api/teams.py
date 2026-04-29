from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from app.config import get_settings
from app.db import get_supabase
from app.email import send_invite_email, send_added_to_org_email
from app.auth_deps import current_user_id
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

# Fixed UUIDs seeded in the roles table
ROLE_IDS = {
    "owner":  "00000000-0000-0000-0000-000000000001",
    "admin":  "00000000-0000-0000-0000-000000000002",
    "member": "00000000-0000-0000-0000-000000000003",
}
ROLE_NAMES = {v: k for k, v in ROLE_IDS.items()}

# Fixed UUIDs seeded in the notification_types table
NOTIF_TYPE_IDS = {
    # user-facing
    "team_invite":        "00000000-0000-0000-0002-000000000001",
    "team_accepted":      "00000000-0000-0000-0002-000000000002",
    "team_declined":      "00000000-0000-0000-0002-000000000003",
    "team_removed":       "00000000-0000-0000-0002-000000000004",
    "role_changed":       "00000000-0000-0000-0002-000000000005",
    "general":            "00000000-0000-0000-0002-000000000006",
    # team API actions
    "create_team":        "00000000-0000-0000-0002-000000000007",
    "update_team":        "00000000-0000-0000-0002-000000000008",
    "add_member":         "00000000-0000-0000-0002-000000000009",
    "invite_member":      "00000000-0000-0000-0002-000000000010",
    "accept_invites":     "00000000-0000-0000-0002-000000000011",
    "decline_invite":     "00000000-0000-0000-0002-000000000012",
    "delete_team":        "00000000-0000-0000-0002-000000000013",
    "change_member_role": "00000000-0000-0000-0002-000000000014",
    "leave_team":         "00000000-0000-0000-0002-000000000015",
    "remove_member":      "00000000-0000-0000-0002-000000000016",
    "revoke_invite":      "00000000-0000-0000-0002-000000000017",
}


def get_role_name(role_id: str | None, fallback: str = "member") -> str:
    """Resolve a role UUID to its display name, falling back gracefully."""
    if not role_id:
        return fallback
    return ROLE_NAMES.get(role_id, role_id)


class TeamCreate(BaseModel):
    name: str
    owner_id: str
    default_ai_model: str = "gpt-4o"
    company_id: Optional[str] = None


class TeamUpdate(BaseModel):
    name: Optional[str] = None
    default_ai_model: Optional[str] = None


class TeamMemberInvite(BaseModel):
    user_id: str
    role: str = "member"


class TeamEmailInvite(BaseModel):
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


def _create_notification(
    db,
    user_id: str,
    type_key: str,
    title: str,
    body: str = "",
    payload: Optional[dict] = None,
) -> None:
    """Insert a real-time notification row for a specific user. Never raises."""
    try:
        db.table("notifications").insert({
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "type_id": NOTIF_TYPE_IDS[type_key],
            "title": title,
            "body": body,
            "payload": payload or {},
        }).execute()
    except Exception:
        pass


def _log_team_event(
    db,
    action: str,
    team_id: Optional[str] = None,
    user_id: Optional[str] = None,
    level: str = "info",
    detail: Optional[dict] = None,
) -> None:
    """Write a non-blocking structured log entry to team_api_logs in Supabase."""
    try:
        db.table("team_api_logs").insert({
            "id": str(uuid.uuid4()),
            "team_id": team_id,
            "user_id": user_id,
            "action_id": NOTIF_TYPE_IDS[action],
            "level": level,
            "detail": detail or {},
        }).execute()
    except Exception:
        pass  # never block the main request


def _require_member(db, team_id: str, user_id: str) -> str:
    """
    Verify that user_id is an active member of team_id and return their raw role UUID.

    Raises HTTP 403 if the user is not a member at all.
    Callers compare the returned UUID against ROLE_IDS constants, e.g.:
        role = _require_member(db, team_id, requester_id)
        if role not in (ROLE_IDS["owner"], ROLE_IDS["admin"]):
            raise HTTPException(403, "...")
    Using UUIDs (not names) means permission checks stay correct even if
    role names are ever renamed in the DB.
    """
    row = (
        db.table("team_members")
        .select("role")           # role column holds a fixed UUID from ROLE_IDS
        .eq("team_id", team_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not row.data:
        raise HTTPException(403, "Not a member of this team")
    # Return the raw role UUID so callers compare against ROLE_IDS constants,
    # which are fixed and cannot be affected by role name changes.
    return row.data[0]["role"]


@router.post("", status_code=201)
def create_team(body: TeamCreate):
    if body.default_ai_model not in AI_MODELS:
        raise HTTPException(400, f"model must be one of {AI_MODELS}")
    db = get_supabase()
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
    }
    if body.company_id:
        row["company_id"] = body.company_id
    db.table("teams").insert(row).execute()
    db.table("team_members").insert({
        "team_id": team_id,
        "user_id": body.owner_id,
        "role": ROLE_IDS["owner"],
    }).execute()
    _log_team_event(db, "create_team", team_id=team_id, user_id=body.owner_id,
                    detail={"name": body.name, "model": body.default_ai_model})
    return {**row, "my_role": "owner"}


@router.get("/my")
def my_teams(user_id: str):
    db = get_supabase()
    members = db.table("team_members").select("team_id, role").eq("user_id", user_id).execute()
    items = members.data or []
    if not items:
        return []
    team_ids = [m["team_id"] for m in items]
    role_map = {m["team_id"]: get_role_name(m["role"]) for m in items}
    teams = db.table("teams").select("*").in_("id", team_ids).execute()
    result = teams.data or []
    for t in result:
        t["my_role"] = role_map.get(t["id"])
    return result


@router.get("/models")
def list_models():
    return {"models": AI_MODELS}


@router.get("/pending-invite")
def get_pending_invite(email: str):
    """Return the first pending invite for the given email, with team details."""
    db = get_supabase()
    norm_email = email.strip().lower()
    invites = (
        db.table("team_invites")
        .select("id,team_id,role,invited_by_email")
        .eq("email", norm_email)
        .eq("status", "pending")
        .limit(1)
        .execute()
    )
    rows = invites.data or []
    if not rows:
        return {"invite": None}
    row = rows[0]
    team = db.table("teams").select("id,name").eq("id", row["team_id"]).single().execute()
    team_name = (team.data or {}).get("name", "a team") if team.data else "a team"
    role_name = get_role_name(row["role"])
    return {
        "invite": {
            "id": row["id"],
            "team_id": row["team_id"],
            "team_name": team_name,
            "invited_by_email": row["invited_by_email"],
            "role": role_name,
        }
    }


@router.get("/{team_id}")
def get_team(team_id: str, caller_id: str = Depends(current_user_id)):
    db = get_supabase()
    team = db.table("teams").select("*").eq("id", team_id).single().execute()
    if not team.data:
        raise HTTPException(404, "Team not found")
    members_resp = db.table("team_members").select("*").eq("team_id", team_id).execute()
    members = members_resp.data or []

    # Resolve caller's role
    caller_member = next((m for m in members if str(m.get("user_id")) == caller_id), None)
    my_role_id = caller_member["role"] if caller_member else None          # raw UUID
    my_role = get_role_name(my_role_id) if my_role_id else None  # display name

    if members:
        users = _extract_auth_users(db.auth.admin.list_users())
        email_by_user_id: dict[str, str] = {}
        name_by_user_id: dict[str, str] = {}
        for u in users:
            uid = _user_id(u)
            if not uid:
                continue
            email_by_user_id[uid] = _user_email(u) or ""
            meta = (u.get("user_metadata") if isinstance(u, dict) else getattr(u, "user_metadata", None)) or {}
            name_by_user_id[uid] = meta.get("full_name") or ""
        for member in members:
            uid = str(member["user_id"])
            member["email"] = email_by_user_id.get(uid)
            member["full_name"] = name_by_user_id.get(uid) or None
            member["role_id"] = member["role"]                              # raw UUID
            member["role"] = get_role_name(member["role"]) # display name

    pending_invites = []
    try:
        pending_resp = (
            db.table("team_invites")
            .select("id,email,role,invited_by_email,status,invited_at")
            .eq("team_id", team_id)
            .eq("status", "pending")
            .order("invited_at", desc=True)
            .execute()
        )
        raw_invites = pending_resp.data or []
        # Exclude invites for emails that are already active members
        # (can happen if a previous accept-invites call failed mid-transaction).
        member_emails = {(m.get("email") or "").lower() for m in members if m.get("email")}
        pending_invites = [i for i in raw_invites if i["email"].lower() not in member_emails]
        # Resolve role UUID → display name for each invite
        for inv in pending_invites:
            inv["role_id"] = inv["role"]
            inv["role"] = get_role_name(inv["role"])
        # Heal stuck invites in the background — mark them accepted.
        stuck_ids = [i["id"] for i in raw_invites if i["email"].lower() in member_emails]
        for sid in stuck_ids:
            try:
                db.table("team_invites").update({"status": "accepted"}).eq("id", sid).execute()
            except Exception:
                pass
    except Exception:
        pending_invites = []

    return {**team.data, "members": members, "pending_invites": pending_invites, "my_role": my_role, "my_role_id": my_role_id}


@router.patch("/{team_id}")
def update_team(team_id: str, body: TeamUpdate):
    db = get_supabase()
    if body.default_ai_model and body.default_ai_model not in AI_MODELS:
        raise HTTPException(400, f"model must be one of {AI_MODELS}")
    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update:
        raise HTTPException(400, "No valid fields to update")
    db.table("teams").update(update).eq("id", team_id).execute()
    _log_team_event(db, "update_team", team_id=team_id, detail=update)
    return {"team_id": team_id, **update}


@router.post("/{team_id}/members", status_code=201)
def add_member(team_id: str, body: TeamMemberInvite):
    db = get_supabase()
    if body.role not in ("owner", "admin", "member"):
        raise HTTPException(400, "role must be owner, admin, or member")
    db.table("team_members").upsert({
        "team_id": team_id,
        "user_id": body.user_id,
        "role": ROLE_IDS[body.role],
    }).execute()
    _log_team_event(db, "add_member", team_id=team_id, user_id=body.user_id,
                    detail={"role": body.role})
    return {"team_id": team_id, "user_id": body.user_id, "role": body.role}


@router.post("/{team_id}/invites", status_code=201)
def invite_member_by_email(team_id: str, body: TeamEmailInvite):
    db = get_supabase()
    settings = get_settings()

    if body.role not in ("owner", "admin", "member"):
        raise HTTPException(400, "role must be owner, admin, or member")

    email = body.email.strip().lower()
    if not _is_valid_email(email):
        raise HTTPException(400, "Invalid email")

    team = db.table("teams").select("id,name,company_id").eq("id", team_id).single().execute()
    if not team.data:
        raise HTTPException(404, "Team not found")

    inviter_role = _require_member(db, team_id, body.invited_by_user_id)
    if inviter_role not in (ROLE_IDS["owner"], ROLE_IDS["admin"]):
        raise HTTPException(403, "Only admins and owners can invite members")

    users_resp = db.auth.admin.list_users()
    users = _extract_auth_users(users_resp)
    inviter_user = next((u for u in users if _user_id(u) == body.invited_by_user_id), None)
    inviter_email = (_user_email(inviter_user) or "Unknown").strip()

    # Always use the pending invite flow — even for confirmed existing users.
    # They will be added to the team when they next log in and accept-invites runs.
    try:
        db.table("team_invites").upsert({
            "team_id": team_id,
            "email": email,
            "role": ROLE_IDS[body.role],
            "invited_by_user_id": body.invited_by_user_id,
            "invited_by_email": inviter_email,
            "status": "pending",
            "company_id": (team.data or {}).get("company_id"),
        }).execute()
    except Exception:
        pass

    invite_error: str | None = None

    # Check upfront if this email already has a Supabase auth account.
    # If so, skip the invite API call entirely (it would throw 'already registered').
    # Only treat as "existing" if the account is confirmed — unconfirmed users
    # should still receive a proper invite link so they can complete sign-up.
    def _is_confirmed(u) -> bool:
        v = u.get("email_confirmed_at") if isinstance(u, dict) else getattr(u, "email_confirmed_at", None)
        return bool(v)

    user_already_exists = any(_user_email(u) == email and _is_confirmed(u) for u in users)
    existing_user_obj = next((u for u in users if _user_email(u) == email and _is_confirmed(u)), None) if user_already_exists else None

    if user_already_exists and existing_user_obj:
        # Create a real-time in-app notification so the user sees the invite instantly.
        _create_notification(
            db,
            user_id=_user_id(existing_user_obj),
            type_key="team_invite",
            title=f"You've been invited to join {team.data['name']}",
            body=f"{inviter_email} invited you to {team.data['name']} as {body.role}.",
            payload={
                "team_id": team_id,
                "team_name": team.data["name"],
                "role": body.role,
                "invited_by_email": inviter_email,
            },
        )

    if settings.postmark_enabled:
        if user_already_exists:
            # Existing user: just send a "you've been added" notification email.
            login_url = f"{settings.frontend_url.rstrip('/')}/invite"
            try:
                send_added_to_org_email(
                    to_email=email,
                    org_name=team.data["name"],
                    inviter_email=inviter_email,
                    role=body.role,
                    frontend_url=login_url,
                )
            except Exception:
                pass
        else:
            try:
                link_resp = db.auth.admin.generate_link({
                    "type": "invite",
                    "email": email,
                    "options": {
                        "data": {
                            "org_id": team_id,
                            "org_role": body.role,
                            "org_name": team.data["name"],
                            "invited_by_email": inviter_email,
                        },
                        "redirect_to": f"{settings.frontend_url.rstrip('/')}/invite",
                    },
                })
                action_link = (
                    getattr(link_resp, "action_link", None)
                    or (link_resp.properties.action_link if hasattr(link_resp, "properties") else None)
                )
                send_invite_email(
                    to_email=email,
                    invite_url=action_link or f"{settings.frontend_url}/login",
                    org_name=team.data["name"],
                    inviter_email=inviter_email,
                    role=body.role,
                )
            except Exception as exc:
                msg = str(exc).lower()
                if (
                    "already registered" in msg
                    or "already exists" in msg
                    or "user exists" in msg
                ):
                    # Race condition: user registered between our list_users call and now.
                    login_url = f"{settings.frontend_url.rstrip('/')}/invite"
                    try:
                        send_added_to_org_email(
                            to_email=email,
                            org_name=team.data["name"],
                            inviter_email=inviter_email,
                            role=body.role,
                            frontend_url=login_url,
                        )
                    except Exception:
                        pass
                elif "already been invited" in msg:
                    try:
                        magic_resp = db.auth.admin.generate_link({
                            "type": "magiclink",
                            "email": email,
                            "options": {
                                "redirect_to": f"{settings.frontend_url.rstrip('/')}/invite",
                            },
                        })
                        magic_link = (
                            getattr(magic_resp, "action_link", None)
                            or (magic_resp.properties.action_link if hasattr(magic_resp, "properties") else None)
                        )
                        send_invite_email(
                            to_email=email,
                            invite_url=magic_link or f"{settings.frontend_url}/invite",
                            org_name=team.data["name"],
                            inviter_email=inviter_email,
                            role=body.role,
                        )
                    except Exception:
                        pass
                else:
                    raise HTTPException(400, f"Failed to send invite: {exc}")
    else:
        if user_already_exists:
            invite_error = "already_exists"
        else:
            try:
                db.auth.admin.invite_user_by_email(
                    email,
                    {
                        "data": {
                            "org_id": team_id,
                            "org_role": body.role,
                            "org_name": team.data["name"],
                            "invited_by_email": inviter_email,
                        },
                        "redirect_to": f"{settings.frontend_url.rstrip('/')}/invite",
                    },
                )
            except Exception as exc:
                msg = str(exc).lower()
                if "rate limit" in msg:
                    invite_error = "rate_limit"
                elif (
                    "already registered" in msg
                    or "already exists" in msg
                    or "user exists" in msg
                    or "already been invited" in msg
                ):
                    invite_error = "already_exists"
                else:
                    raise HTTPException(400, f"Failed to send invite: {exc}")

    status = "invite_sent"
    if invite_error == "rate_limit":
        status = "invite_queued"

    # If the invited email already has an account, record that they've been invited
    # so the funnel shows 'invited' until they accept.
    try:
        existing_user = db.auth.admin.list_users()
        invited_user = next(
            (u for u in (existing_user or []) if getattr(u, "email", "") == email),
            None,
        )
        if invited_user:
            db.table("user_signups").upsert({
                "user_id": str(invited_user.id),
                "origin": "team_invite",
                "signup_status": "invited",
                "team_id": team_id,
                "invited_by_email": inviter_email,
            }, on_conflict="user_id").execute()
    except Exception:
        pass  # Non-blocking

    _log_team_event(db, "invite_member", team_id=team_id, user_id=body.invited_by_user_id,
                    detail={"email": email, "role": body.role, "status": status})
    return {
        "status": status,
        "email": email,
        "team_id": team_id,
        "role": body.role,
        "team": team.data["name"],
        "invited_by_email": inviter_email,
    }


class AcceptInvitesBody(BaseModel):
    user_id: str
    email: str
    team_id: Optional[str] = None
    password: Optional[str] = None
    full_name: Optional[str] = None


@router.post("/accept-invites")
def accept_pending_invites(body: AcceptInvitesBody):
    db = get_supabase()
    try:
        return _do_accept_invites(db, body)
    except Exception as exc:
        import logging
        logging.getLogger(__name__).error("accept-invites failed: %s", exc, exc_info=True)
        # Return a safe response — the frontend already treats this as non-blocking.
        return {"accepted": 0, "team_ids": [], "error": str(exc)}


def _do_accept_invites(db, body: AcceptInvitesBody) -> dict:
    if body.full_name is not None and len(body.full_name.strip()) < 4:
        raise HTTPException(400, "Full name must be at least 4 characters")
    if body.password is not None and len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")

    # Atomically set password + name BEFORE accepting the invite so the user
    # always has their profile set if they join a team successfully.
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
            db.auth.admin.update_user_by_id(body.user_id, user_update)
        except Exception as exc:
            raise HTTPException(400, f"Failed to update profile: {exc}")

    email = body.email.strip().lower()
    query = (
        db.table("team_invites")
        .select("id,team_id,role")
        .eq("email", email)
        .eq("status", "pending")
    )
    if body.team_id:
        query = query.eq("team_id", body.team_id)
    pending = query.execute()
    rows = pending.data or []

    if not rows:
        return {"accepted": 0, "team_ids": []}

    target_team_ids = [r["team_id"] for r in rows]
    teams = db.table("teams").select("id,company_id").in_("id", target_team_ids).execute()
    company_ids = list({t["company_id"] for t in (teams.data or []) if t.get("company_id")})

    if company_ids:
        target_company_id = company_ids[0]
        other_memberships = (
            db.table("company_members")
            .select("company_id")
            .eq("user_id", body.user_id)
            .neq("company_id", target_company_id)
            .execute()
        )
        for cm in (other_memberships.data or []):
            old_cid = cm["company_id"]
            old_teams = db.table("teams").select("id").eq("company_id", old_cid).execute()
            for ot in (old_teams.data or []):
                db.table("team_members").delete().eq("user_id", body.user_id).eq("team_id", ot["id"]).execute()
            db.table("company_members").delete().eq("user_id", body.user_id).eq("company_id", old_cid).execute()
        db.table("company_members").upsert({
            "company_id": target_company_id,
            "user_id": body.user_id,
            "role": ROLE_IDS["member"],
        }).execute()
    else:
        db.table("team_members").delete().eq("user_id", body.user_id).execute()

    accepted_team_ids: list[str] = []
    for row in rows:
        # row["role"] is already a UUID from team_invites.role
        db.table("team_members").upsert({
            "team_id": row["team_id"],
            "user_id": body.user_id,
            "role": row["role"],
        }).execute()
        # Always mark the invite accepted — even if the member row already existed
        # (heals stuck invites from previous partial failures).
        db.table("team_invites").update({
            "status": "accepted",
            "accepted_user_id": body.user_id,
            "accepted_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", row["id"]).execute()
        accepted_team_ids.append(row["team_id"])

    # Upsert the signup record: mark the user as having joined via team invite.
    # If the user was already tracked as 'organic' we still update signup_status
    # to 'team_join' so the funnel stays accurate.
    if accepted_team_ids:
        try:
            db.table("user_signups").upsert({
                "user_id": str(body.user_id),
                "origin": "team_invite",
                "signup_status": "team_join",
                "team_id": accepted_team_ids[0],
                "completed_at": datetime.now(timezone.utc).isoformat(),
            }, on_conflict="user_id").execute()
        except Exception:
            pass  # Non-blocking

    _log_team_event(db, "accept_invites", user_id=str(body.user_id),
                    detail={"accepted": len(accepted_team_ids), "team_ids": accepted_team_ids})
    return {"accepted": len(accepted_team_ids), "team_ids": accepted_team_ids}


@router.post("/invites/{invite_id}/decline", status_code=204)
def decline_invite(invite_id: str):
    """Mark an invite as declined by the invitee."""
    db = get_supabase()
    db.table("team_invites").update({"status": "declined"}).eq("id", invite_id).execute()
    _log_team_event(db, "decline_invite", detail={"invite_id": invite_id})


@router.delete("/{team_id}", status_code=204)
def delete_team(team_id: str, requester_id: str = Depends(current_user_id)):
    db = get_supabase()
    if _require_member(db, team_id, requester_id) != ROLE_IDS["owner"]:
        raise HTTPException(403, "Only the team owner can delete the team")
    db.table("team_members").delete().eq("team_id", team_id).execute()
    db.table("team_invites").delete().eq("team_id", team_id).execute()
    db.table("teams").delete().eq("id", team_id).execute()
    _log_team_event(db, "delete_team", team_id=team_id, user_id=requester_id)


class RoleUpdate(BaseModel):
    role: str  # "admin" | "member"


@router.patch("/{team_id}/members/{user_id}", status_code=200)
def change_member_role(team_id: str, user_id: str, body: RoleUpdate, requester_id: str = Depends(current_user_id)):
    new_role_name = body.role.lower()
    if new_role_name not in ("admin", "member"):
        raise HTTPException(400, "role must be 'admin' or 'member'")
    db = get_supabase()
    requester_role = _require_member(db, team_id, requester_id)
    if requester_role != ROLE_IDS["owner"]:
        raise HTTPException(403, "Only the team owner can change member roles")
    if requester_id == user_id:
        raise HTTPException(403, "Cannot change your own role")
    target_role = _require_member(db, team_id, user_id)
    if target_role == ROLE_IDS["owner"]:
        raise HTTPException(403, "Cannot change the owner's role")
    new_role_id = ROLE_IDS[new_role_name]
    db.table("team_members").update({"role": new_role_id}).eq("team_id", team_id).eq("user_id", user_id).execute()
    _log_team_event(db, "change_member_role", team_id=team_id, user_id=requester_id,
                    detail={"target_user_id": user_id, "new_role": new_role_name})
    return {"role": new_role_name}


@router.delete("/{team_id}/members/{user_id}", status_code=204)
def remove_member(team_id: str, user_id: str, requester_id: str = Depends(current_user_id)):
    db = get_supabase()
    requester_role = _require_member(db, team_id, requester_id)

    # Allow self-leave without further role check
    if requester_id == user_id:
        if requester_role == ROLE_IDS["owner"]:
            raise HTTPException(403, "Team owner cannot leave — transfer ownership or delete the team first")
        db.table("team_members").delete().eq("team_id", team_id).eq("user_id", user_id).execute()
        _log_team_event(db, "leave_team", team_id=team_id, user_id=user_id)
        return

    if requester_role not in (ROLE_IDS["owner"], ROLE_IDS["admin"]):
        raise HTTPException(403, "Only admins and owners can remove members")

    target_role = _require_member(db, team_id, user_id)
    if target_role == ROLE_IDS["owner"]:
        raise HTTPException(403, "Cannot remove the team owner")
    if target_role == ROLE_IDS["admin"] and requester_role != ROLE_IDS["owner"]:
        raise HTTPException(403, "Only the team owner can remove an admin")

    db.table("team_members").delete().eq("team_id", team_id).eq("user_id", user_id).execute()
    _log_team_event(db, "remove_member", team_id=team_id, user_id=requester_id,
                    detail={"target_user_id": user_id})


@router.delete("/{team_id}/invites/{invite_id}", status_code=204)
def revoke_invite(team_id: str, invite_id: str, requester_id: str = Depends(current_user_id)):
    db = get_supabase()
    try:
        role = _require_member(db, team_id, requester_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Could not verify membership: {exc}")
    if role not in (ROLE_IDS["owner"], ROLE_IDS["admin"]):
        raise HTTPException(403, "Only admins and owners can revoke invites")
    try:
        db.table("team_invites").delete().eq("id", invite_id).eq("team_id", team_id).execute()
    except Exception as exc:
        raise HTTPException(500, f"Failed to revoke invite: {exc}")
    _log_team_event(db, "revoke_invite", team_id=team_id, user_id=requester_id,
                    detail={"invite_id": invite_id})
