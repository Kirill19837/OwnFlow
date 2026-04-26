from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db import get_supabase
from app.config import get_settings
from app.email import send_signup_confirmation_email, send_magic_link_email

router = APIRouter(prefix="/auth", tags=["auth"])


class SignupBody(BaseModel):
    email: str
    password: str
    name: Optional[str] = None


@router.post("/signup", status_code=201)
def signup(body: SignupBody):
    """
    Create a new user and send a branded confirmation email via Postmark.
    Bypasses Supabase's own mailer so we control deliverability and design.
    """
    db = get_supabase()
    settings = get_settings()

    try:
        link_resp = db.auth.admin.generate_link({
            "type": "signup",
            "email": body.email,
            "password": body.password,
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

    # Persist the display name in user_metadata if provided.
    if body.name and body.name.strip():
        try:
            user_obj = getattr(link_resp, "user", None) or getattr(getattr(link_resp, "properties", None), "user", None)
            user_id = getattr(user_obj, "id", None)
            if user_id:
                db.auth.admin.update_user_by_id(user_id, {"user_metadata": {"full_name": body.name.strip()}})
        except Exception:
            pass  # Non-blocking — account still created

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


@router.post("/magic-link", status_code=200)
def send_magic_link(body: MagicLinkBody):
    """
    Generate a magic-link (OTP) for an existing user and deliver it via Postmark.
    The caller is responsible for client-side rate limiting (e.g. once per hour).
    """
    db = get_supabase()
    settings = get_settings()

    email = body.email.strip().lower()

    try:
        link_resp = db.auth.admin.generate_link({
            "type": "magiclink",
            "email": email,
            "options": {
                "redirect_to": f"{settings.frontend_url.rstrip('/')}/login?link_type={body.link_type}",
            },
        })
    except Exception as exc:
        # Don't leak whether the email exists — return success either way
        # to prevent user enumeration.
        import logging
        logging.getLogger(__name__).warning("magic-link generate_link failed for %s: %s", email, exc)
        return {"status": "sent", "email": email}

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
