from __future__ import annotations

import httpx
from app.config import get_settings


def send_invite_email(
    to_email: str,
    invite_url: str,
    org_name: str,
    inviter_email: str,
    role: str,
) -> None:
    settings = get_settings()
    if not settings.postmark_enabled:
        raise RuntimeError("Postmark not configured")

    html = f"""
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:32px;">
  <div style="max-width:520px;margin:0 auto;background:#1e293b;border-radius:12px;padding:32px;border:1px solid #334155;">
    <h1 style="font-size:22px;font-weight:700;color:#a78bfa;margin-bottom:8px;">OwnFlow</h1>
    <h2 style="font-size:18px;font-weight:600;color:#f1f5f9;margin-bottom:20px;">
      You've been invited to join <span style="color:#a78bfa">{org_name}</span>
    </h2>
    <p style="color:#94a3b8;margin-bottom:8px;">
      <strong style="color:#e2e8f0">{inviter_email}</strong> has invited you to join
      <strong style="color:#e2e8f0">{org_name}</strong> as a <strong style="color:#e2e8f0">{role}</strong>.
    </p>
    <p style="color:#94a3b8;margin-bottom:28px;">
      Click the button below to accept the invitation and set up your account.
    </p>
    <a href="{invite_url}"
       style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;
              padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">
      Accept invitation
    </a>
    <p style="color:#475569;font-size:12px;margin-top:28px;">
      If you didn't expect this invitation, you can safely ignore this email.<br>
      This link expires in 24 hours.
    </p>
  </div>
</body>
</html>
"""

    resp = httpx.post(
        "https://api.postmarkapp.com/email",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": settings.postmark_token,
        },
        json={
            "From": settings.postmark_from,
            "To": to_email,
            "Subject": f"You've been invited to join {org_name} on OwnFlow",
            "HtmlBody": html,
            "TextBody": (
                f"{inviter_email} has invited you to join {org_name} as {role}.\n\n"
                f"Accept your invitation: {invite_url}\n\n"
                "This link expires in 24 hours."
            ),
            "MessageStream": "outbound",
        },
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Postmark error {resp.status_code}: {resp.text}")


def send_added_to_org_email(
    to_email: str,
    org_name: str,
    inviter_email: str,
    role: str,
    frontend_url: str,
) -> None:
    settings = get_settings()
    if not settings.postmark_enabled:
        return

    html = f"""
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:32px;">
  <div style="max-width:520px;margin:0 auto;background:#1e293b;border-radius:12px;padding:32px;border:1px solid #334155;">
    <h1 style="font-size:22px;font-weight:700;color:#a78bfa;margin-bottom:8px;">OwnFlow</h1>
    <h2 style="font-size:18px;font-weight:600;color:#f1f5f9;margin-bottom:20px;">
      You've been added to <span style="color:#a78bfa">{org_name}</span>
    </h2>
    <p style="color:#94a3b8;margin-bottom:28px;">
      <strong style="color:#e2e8f0">{inviter_email}</strong> added you to
      <strong style="color:#e2e8f0">{org_name}</strong> as a <strong style="color:#e2e8f0">{role}</strong>.
      You can log in to start collaborating.
    </p>
    <a href="{frontend_url}"
       style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;
              padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">
      Open OwnFlow
    </a>
    <p style="color:#475569;font-size:12px;margin-top:28px;">
      If you didn't expect this, please contact {inviter_email}.
    </p>
  </div>
</body>
</html>
"""

    resp = httpx.post(
        "https://api.postmarkapp.com/email",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": settings.postmark_token,
        },
        json={
            "From": settings.postmark_from,
            "To": to_email,
            "Subject": f"You've been added to {org_name} on OwnFlow",
            "HtmlBody": html,
            "TextBody": (
                f"{inviter_email} added you to {org_name} as {role}.\n\n"
                f"Log in to OwnFlow: {frontend_url}"
            ),
            "MessageStream": "outbound",
        },
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Postmark error {resp.status_code}: {resp.text}")


def send_signup_confirmation_email(
    to_email: str,
    confirmation_url: str,
) -> None:
    settings = get_settings()
    if not settings.postmark_enabled:
        raise RuntimeError("Postmark not configured")

    html = f"""
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:32px;">
  <div style="max-width:520px;margin:0 auto;background:#1e293b;border-radius:12px;padding:32px;border:1px solid #334155;">
    <h1 style="font-size:22px;font-weight:700;color:#a78bfa;margin-bottom:8px;">OwnFlow</h1>
    <h2 style="font-size:18px;font-weight:600;color:#f1f5f9;margin-bottom:16px;">
      Confirm your email address
    </h2>
    <p style="color:#94a3b8;margin-bottom:8px;">
      Thanks for signing up! Click the button below to confirm your email and activate your account.
    </p>
    <p style="color:#94a3b8;margin-bottom:28px;">
      This link expires in <strong style="color:#e2e8f0">24 hours</strong>.
    </p>
    <a href="{confirmation_url}"
       style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;
              padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">
      Confirm email address
    </a>
    <p style="color:#475569;font-size:12px;margin-top:28px;">
      If you didn't create an OwnFlow account, you can safely ignore this email.
    </p>
  </div>
</body>
</html>
"""

    resp = httpx.post(
        "https://api.postmarkapp.com/email",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": settings.postmark_token,
        },
        json={
            "From": settings.postmark_from,
            "To": to_email,
            "Subject": "Confirm your OwnFlow account",
            "HtmlBody": html,
            "TextBody": (
                "Thanks for signing up for OwnFlow!\n\n"
                f"Confirm your email address: {confirmation_url}\n\n"
                "This link expires in 24 hours."
            ),
            "MessageStream": "outbound",
        },
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Postmark error {resp.status_code}: {resp.text}")


def send_magic_link_email(
    to_email: str,
    magic_url: str,
) -> None:
    settings = get_settings()
    if not settings.postmark_enabled:
        raise RuntimeError("Postmark not configured")

    html = f"""
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:32px;">
  <div style="max-width:520px;margin:0 auto;background:#1e293b;border-radius:12px;padding:32px;border:1px solid #334155;">
    <h1 style="font-size:22px;font-weight:700;color:#a78bfa;margin-bottom:8px;">OwnFlow</h1>
    <h2 style="font-size:18px;font-weight:600;color:#f1f5f9;margin-bottom:16px;">
      Sign in to OwnFlow
    </h2>
    <p style="color:#94a3b8;margin-bottom:8px;">
      Click the button below to sign in. No password needed &mdash; this link works once.
    </p>
    <p style="color:#94a3b8;margin-bottom:28px;">
      This link expires in <strong style="color:#e2e8f0">1 hour</strong>.
    </p>
    <a href="{magic_url}"
       style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;
              padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">
      Sign in to OwnFlow
    </a>
    <p style="color:#475569;font-size:12px;margin-top:28px;">
      If you didn't request this link, you can safely ignore this email.
    </p>
  </div>
</body>
</html>
"""

    resp = httpx.post(
        "https://api.postmarkapp.com/email",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": settings.postmark_token,
        },
        json={
            "From": settings.postmark_from,
            "To": to_email,
            "Subject": "Your OwnFlow sign-in link",
            "HtmlBody": html,
            "TextBody": (
                "Sign in to OwnFlow \u2014 click the link below (expires in 1 hour):\n\n"
                f"{magic_url}\n\n"
                "If you didn't request this, ignore this email."
            ),
            "MessageStream": "outbound",
        },
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Postmark error {resp.status_code}: {resp.text}")
