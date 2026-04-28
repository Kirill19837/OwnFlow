import secrets
import string
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.db import get_supabase
from app.config import get_settings
from app.email import send_signup_confirmation_email, send_magic_link_email
from app.auth_deps import current_user_id

router = APIRouter(prefix="/auth", tags=["auth"])


def _generate_password(length: int = 32) -> str:
    alphabet = string.ascii_letters + string.digits + string.punctuation
    return ''.join(secrets.choice(alphabet) for _ in range(length))


class SignupBody(BaseModel):
    email: str
    password: Optional[str] = None
    name: Optional[str] = None


@router.post("/signup", status_code=201)
def signup(body: SignupBody):
    """
    Create a new user and send a branded confirmation email via Postmark.
    Bypasses Supabase's own mailer so we control deliverability and design.
    """
    db = get_supabase()
    settings = get_settings()

    password = body.password or _generate_password()

    try:
        link_resp = db.auth.admin.generate_link({
            "type": "signup",
            "email": body.email,
            "password": password,
            "options": {
                "redirect_to": f"{settings.frontend_url.rstrip('/')}/",
            },
        })
    except Exception as exc:
        msg = str(exc).lower()
        if "already registered" in msg or "already been registered" in msg or "user already exists" in msg:
            raise HTTPException(400, "An account with this email already exists.")
        raise HTTPException(400, f"Signup failed: {exc}")

    action_link = (
        getattr(link_resp, "action_link", None)
        or (link_resp.properties.action_link if hasattr(link_resp, "properties") else None)
    )
    if not action_link:
        raise HTTPException(500, "Could not generate confirmation link.")

    # Extract the newly-created user ID (shared by name metadata and origin tracking).
    _new_user_obj = getattr(link_resp, "user", None) or getattr(getattr(link_resp, "properties", None), "user", None)
    _new_user_id = getattr(_new_user_obj, "id", None)

    # Persist the display name in user_metadata if provided.
    if body.name and body.name.strip() and _new_user_id:
        try:
            db.auth.admin.update_user_by_id(_new_user_id, {"user_metadata": {"full_name": body.name.strip()}})
        except Exception:
            pass  # Non-blocking — account still created

    # Record this user's origin so the frontend knows to show the company-setup flow.
    if _new_user_id:
        try:
            db.table("user_signups").insert({
                "user_id": str(_new_user_id),
                "origin": "organic",
                # signup_status is null for organic users until they create a company
            }).execute()
        except Exception:
            pass  # Non-blocking

    try:
        send_signup_confirmation_email(
            to_email=body.email,
            confirmation_url=action_link,
        )
    except Exception as exc:
        raise HTTPException(500, f"Account created but failed to send confirmation email: {exc}")

    return {"status": "confirmation_sent", "email": body.email}


@router.get("/has-password")
def has_password(user_id: str):
    """
    Returns whether the user has an encrypted password set.
    Used by the frontend to decide whether to prompt for password creation
    after a magic-link or invite sign-in.
    """
    db = get_supabase()
    try:
        resp = db.auth.admin.get_user_by_id(user_id)
        user = resp.user
        # encrypted_password may be on the model directly or in model_extra (pydantic v2)
        pw = getattr(user, "encrypted_password", None)
        if pw is None:
            pw = (getattr(user, "model_extra", None) or {}).get("encrypted_password")
        return {"has_password": bool(pw)}
    except Exception:
        # Fail open — assume password exists to avoid forced modal on error
        return {"has_password": True}


class MagicLinkBody(BaseModel):
    email: str
    link_type: str = "set_password"


# In-memory rate limit: one magic link per email per 20 minutes.
# Keyed by lowercased email, value is the Unix timestamp of the last send.
# TODO: move to a DB table (e.g. magic_link_rate_limits) so the limit survives
#       restarts and is enforced across multiple workers/replicas.
#       Suggested schema:
#         email TEXT PRIMARY KEY, sent_at TIMESTAMPTZ NOT NULL
#       Upsert on each send; check (now() - sent_at) < interval '20 minutes'.
_magic_link_sent_at: dict[str, float] = {}
_MAGIC_LINK_COOLDOWN_SECONDS = 20 * 60  # 20 minutes


@router.post("/magic-link", status_code=200)
def send_magic_link(body: MagicLinkBody):
    """
    Generate a magic-link (OTP) for an existing user and deliver it via Postmark.
    Server-side rate limit: one email per address per 20 minutes.
    """
    import time
    db = get_supabase()
    settings = get_settings()

    email = body.email.strip().lower()

    # Server-side rate limit — silently drop without leaking account existence
    last_sent = _magic_link_sent_at.get(email, 0)
    if time.time() - last_sent < _MAGIC_LINK_COOLDOWN_SECONDS:
        return {"status": "sent", "email": email}

    try:
        link_resp = db.auth.admin.generate_link({
            "type": "magiclink",
            "email": email,
            "options": {
                "redirect_to": f"{settings.frontend_url.rstrip('/')}/login?link_type={body.link_type}",
            },
        })
        action_link = (
            getattr(link_resp, "action_link", None)
            or (link_resp.properties.action_link if hasattr(link_resp, "properties") else None)
        )
        if action_link and settings.postmark_enabled:
            from app.email import send_magic_link_email
            send_magic_link_email(to_email=email, magic_url=action_link)
        _magic_link_sent_at[email] = time.time()
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("magic-link generate_link failed for %s: %s", email, exc)

    return {"status": "sent", "email": email}


class CreateCompanyInviteBody(BaseModel):
    email: str


@router.post("/create-company-invite", status_code=200)
def create_company_invite(body: CreateCompanyInviteBody):
    """
    Invite a brand-new user to OwnFlow to create their own company.
    Generates a Supabase invite link with link_type=create_company so the
    frontend sends them to /company/new after they set their name and password.
    """
    db = get_supabase()
    settings = get_settings()
    email = body.email.strip().lower()
    try:
        link_resp = db.auth.admin.generate_link({
            "type": "invite",
            "email": email,
            "options": {
                "redirect_to": f"{settings.frontend_url.rstrip('/')}/login?link_type=create_company",
            },
        })
        action_link = (
            getattr(link_resp, "action_link", None)
            or (link_resp.properties.action_link if hasattr(link_resp, "properties") else None)
        )
        if action_link and settings.postmark_enabled:
            try:
                send_magic_link_email(to_email=email, magic_url=action_link)
            except Exception:
                pass  # Non-blocking
        return {"status": "sent", "email": email}
    except Exception as exc:
        raise HTTPException(400, f"Failed to generate invite: {exc}")


@router.delete("/account", status_code=204)
def delete_account(user_id: str = Depends(current_user_id)):
    """
    Permanently delete the calling user's account.
    Blocked if the user is the owner of any company — they must transfer
    ownership or delete the company first.
    """
    db = get_supabase()
    owned = db.table("companies").select("id").eq("owner_id", user_id).execute()
    if owned.data:
        raise HTTPException(
            403,
            "You are the owner of a company. Delete the company or transfer ownership before deleting your account.",
        )
    db.table("team_members").delete().eq("user_id", user_id).execute()
    db.table("company_members").delete().eq("user_id", user_id).execute()
    try:
        db.auth.admin.delete_user(user_id)
    except Exception as exc:
        raise HTTPException(500, f"Failed to delete auth user: {exc}")


@router.get("/my-origin")
def get_my_origin(user_id: str = Depends(current_user_id)):
    """
    Return how the calling user first entered the product.
    'organic'     → self-signup; frontend should show company-setup flow.
    'team_invite' → arrived via a team invitation; skip company creation.
    Defaults to 'organic' for users who signed up before this feature.
    """
    db = get_supabase()
    resp = db.table("user_signups").select("origin").eq("user_id", user_id).maybe_single().execute()
    if resp.data:
        return {"origin": resp.data["origin"]}
    # Safe default: send unknown users through company-setup
    return {"origin": "organic"}
