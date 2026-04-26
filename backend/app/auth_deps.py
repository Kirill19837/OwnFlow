"""
FastAPI dependency for extracting and verifying the caller's identity from the
Supabase JWT sent in the Authorization: Bearer header.

Usage:
    from app.auth_deps import current_user_id

    @router.delete("/{team_id}", status_code=204)
    def delete_team(team_id: str, uid: str = Depends(current_user_id)):
        ...
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from app.db import get_supabase

_bearer = HTTPBearer(auto_error=True)


def current_user_id(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> str:
    """
    Verify the Bearer JWT via Supabase and return the authenticated user ID.
    Raises 401 if the token is missing, malformed, or expired.
    """
    token = credentials.credentials
    db = get_supabase()
    try:
        resp = db.auth.get_user(token)
        user = getattr(resp, "user", None)
        user_id = getattr(user, "id", None) if user else None
        if not user_id:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
        return str(user_id)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Could not validate credentials")
