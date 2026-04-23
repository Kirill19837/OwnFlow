from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db import get_supabase
from app.config import get_settings
from app.email import send_signup_confirmation_email, send_magic_link_email

router = APIRouter(prefix="/auth", tags=["auth"])


class SignupBody(BaseModel):
    email: str
    password: str


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

    try:
        send_signup_confirmation_email(
            to_email=body.email,
            confirmation_url=action_link,
        )
    except Exception as exc:
        raise HTTPException(500, f"Account created but failed to send confirmation email: {exc}")

    return {"status": "confirmation_sent", "email": body.email}


class MagicLinkBody(BaseModel):
    email: str


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
                "redirect_to": f"{settings.frontend_url.rstrip('/')}/",
            },
        })
    except Exception as exc:
        # Don't leak whether the email exists — return success either way
        # to prevent user enumeration.
        import logging
        logging.getLogger(__name__).warning("magic-link generate_link failed for %s: %s", email, exc)
        return {"status": "sent", "email": email}

    action_link = (
        getattr(link_resp, "action_link", None)
        or (link_resp.properties.action_link if hasattr(link_resp, "properties") else None)
    )
    if action_link:
        try:
            send_magic_link_email(to_email=email, magic_url=action_link)
        except Exception as exc:
            raise HTTPException(500, f"Failed to send magic link email: {exc}")

    return {"status": "sent", "email": email}
