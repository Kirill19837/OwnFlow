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
