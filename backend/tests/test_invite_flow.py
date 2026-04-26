"""
Tests for the org invite flow.

All Supabase DB/auth calls and email sending are mocked — no real DB or network
connections are made.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Helpers to build minimal fake Supabase responses
# ---------------------------------------------------------------------------

ORG_ID = str(uuid.uuid4())
OWNER_ID = str(uuid.uuid4())
INVITEE_ID = str(uuid.uuid4())
INVITEE_EMAIL = "invitee@example.com"
OWNER_EMAIL = "owner@example.com"

# Role UUIDs must match the seeded roles table
ROLE_OWNER  = "00000000-0000-0000-0000-000000000001"
ROLE_ADMIN  = "00000000-0000-0000-0000-000000000002"
ROLE_MEMBER = "00000000-0000-0000-0000-000000000003"

_ORG_ROW = {
    "id": ORG_ID,
    "name": "Test Org",
    "slug": "test-org",
    "owner_id": OWNER_ID,
    "default_ai_model": "gpt-4o",
}


def _resp(data):
    """Return a minimal Supabase-like response object."""
    r = MagicMock()
    r.data = data
    return r


def _user(user_id: str, email: str, confirmed: bool = True):
    u = SimpleNamespace(
        id=user_id,
        email=email,
        email_confirmed_at="2024-01-01T00:00:00Z" if confirmed else None,
    )
    return u


# ---------------------------------------------------------------------------
# Fixture: TestClient with mocked db
# ---------------------------------------------------------------------------

@pytest.fixture()
def client():
    from app.main import app
    return TestClient(app, raise_server_exceptions=True)


def _patch_db(db_mock):
    """Patch get_supabase to return db_mock everywhere."""
    return patch("app.api.teams.get_supabase", return_value=db_mock)


# ---------------------------------------------------------------------------
# 1. Invite a brand-new email (not in auth) — should store pending + send email
# ---------------------------------------------------------------------------

def test_invite_new_email_sends_invite(client):
    db = MagicMock()

    # org exists
    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(_ORG_ROW)

    # inviter is a member
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"user_id": OWNER_ID}]
    )

    # list_users: only owner exists, invitee does NOT exist
    owner_user = _user(OWNER_ID, OWNER_EMAIL)
    db.auth.admin.list_users.return_value = [owner_user]

    # org_invites upsert succeeds
    db.table.return_value.upsert.return_value.execute.return_value = _resp([])

    # generate_link returns an action_link
    link_resp = SimpleNamespace(
        action_link="https://supabase.co/auth/confirm?token=abc",
        properties=SimpleNamespace(action_link="https://supabase.co/auth/confirm?token=abc"),
        user=SimpleNamespace(id=INVITEE_ID),
    )
    db.auth.admin.generate_link.return_value = link_resp

    with _patch_db(db):
        with patch("app.api.teams.send_invite_email") as mock_send:
            with patch("app.api.teams.get_settings") as mock_settings:
                s = MagicMock()
                s.postmark_enabled = True
                s.frontend_url = "http://localhost:5173"
                mock_settings.return_value = s

                resp = client.post(f"/teams/{ORG_ID}/invites", json={
                    "email": INVITEE_EMAIL,
                    "role": "member",
                    "invited_by_user_id": OWNER_ID,
                })

    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "invite_sent"
    assert body["email"] == INVITEE_EMAIL
    mock_send.assert_called_once()
    call_kwargs = mock_send.call_args.kwargs
    assert call_kwargs["to_email"] == INVITEE_EMAIL
    assert call_kwargs["org_name"] == "Test Org"


# ---------------------------------------------------------------------------
# 2. Invite a confirmed existing user — adds to org directly, sends notification
# ---------------------------------------------------------------------------

def test_invite_confirmed_existing_user_goes_through_pending_flow(client):
    """Confirmed existing Supabase users must also go through the pending invite flow."""
    db = MagicMock()

    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(_ORG_ROW)
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"user_id": OWNER_ID}]
    )

    existing = _user(INVITEE_ID, INVITEE_EMAIL, confirmed=True)
    owner_user = _user(OWNER_ID, OWNER_EMAIL, confirmed=True)
    db.auth.admin.list_users.return_value = [owner_user, existing]

    db.table.return_value.upsert.return_value.execute.return_value = _resp([])

    # generate_link raises "already registered" for a confirmed user
    db.auth.admin.generate_link.side_effect = Exception("User already registered")

    with _patch_db(db):
        with patch("app.api.teams.send_added_to_org_email") as mock_notify:
            with patch("app.api.teams.get_settings") as mock_settings:
                s = MagicMock()
                s.postmark_enabled = True
                s.frontend_url = "http://localhost:5173"
                mock_settings.return_value = s

                resp = client.post(f"/teams/{ORG_ID}/invites", json={
                    "email": INVITEE_EMAIL,
                    "role": "member",
                    "invited_by_user_id": OWNER_ID,
                })

    assert resp.status_code == 201
    body = resp.json()
    # Status must NOT be "added_existing_user" — invite stays pending
    assert body["status"] == "invite_sent"
    # A notification email should still be sent so user knows to log in
    mock_notify.assert_called_once()
    assert mock_notify.call_args.kwargs["to_email"] == INVITEE_EMAIL


# ---------------------------------------------------------------------------
# 3. Invite an unconfirmed user — should go through invite flow, NOT add directly
# ---------------------------------------------------------------------------

def test_invite_unconfirmed_user_goes_through_invite_flow(client):
    db = MagicMock()

    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(_ORG_ROW)
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"user_id": OWNER_ID}]
    )

    # Invitee exists in auth but email_confirmed_at is None
    unconfirmed = _user(INVITEE_ID, INVITEE_EMAIL, confirmed=False)
    owner_user = _user(OWNER_ID, OWNER_EMAIL, confirmed=True)
    db.auth.admin.list_users.return_value = [owner_user, unconfirmed]

    db.table.return_value.upsert.return_value.execute.return_value = _resp([])

    link_resp = SimpleNamespace(
        action_link="https://supabase.co/auth/confirm?token=xyz",
        properties=SimpleNamespace(action_link="https://supabase.co/auth/confirm?token=xyz"),
        user=SimpleNamespace(id=INVITEE_ID),
    )
    db.auth.admin.generate_link.return_value = link_resp

    with _patch_db(db):
        with patch("app.api.teams.send_invite_email") as mock_send:
            with patch("app.api.teams.send_added_to_org_email") as mock_notify:
                with patch("app.api.teams.get_settings") as mock_settings:
                    s = MagicMock()
                    s.postmark_enabled = True
                    s.frontend_url = "http://localhost:5173"
                    mock_settings.return_value = s

                    resp = client.post(f"/teams/{ORG_ID}/invites", json={
                        "email": INVITEE_EMAIL,
                        "role": "member",
                        "invited_by_user_id": OWNER_ID,
                    })

    assert resp.status_code == 201
    body = resp.json()
    # Should NOT be treated as existing user
    assert body["status"] != "added_existing_user"
    # invite email sent, NOT the "added" notification
    mock_send.assert_called_once()
    mock_notify.assert_not_called()


# ---------------------------------------------------------------------------
# 4. Invalid email is rejected
# ---------------------------------------------------------------------------

def test_invite_invalid_email_returns_400(client):
    db = MagicMock()
    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(_ORG_ROW)
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"user_id": OWNER_ID}]
    )
    db.auth.admin.list_users.return_value = [_user(OWNER_ID, OWNER_EMAIL)]

    with _patch_db(db):
        with patch("app.api.teams.get_settings") as mock_settings:
            s = MagicMock()
            s.postmark_enabled = False
            mock_settings.return_value = s

            resp = client.post(f"/teams/{ORG_ID}/invites", json={
                "email": "not-an-email",
                "role": "member",
                "invited_by_user_id": OWNER_ID,
            })

    assert resp.status_code == 400
    assert "Invalid email" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# 5. Non-member cannot invite
# ---------------------------------------------------------------------------

def test_non_member_cannot_invite(client):
    db = MagicMock()
    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(_ORG_ROW)

    # inviter is NOT a member (empty result)
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp([])

    with _patch_db(db):
        with patch("app.api.teams.get_settings") as mock_settings:
            s = MagicMock()
            s.postmark_enabled = False
            mock_settings.return_value = s

            resp = client.post(f"/teams/{ORG_ID}/invites", json={
                "email": INVITEE_EMAIL,
                "role": "member",
                "invited_by_user_id": str(uuid.uuid4()),
            })

    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 6. accept-invites: marks pending invites accepted and adds to team_members
# ---------------------------------------------------------------------------

def test_accept_invites_adds_member_and_marks_accepted(client):
    db = MagicMock()

    invite_id = str(uuid.uuid4())
    # role is UUID (as stored in team_invites.role)
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value = _resp([
        {"id": invite_id, "team_id": ORG_ID, "role": ROLE_MEMBER},
    ])
    db.table.return_value.upsert.return_value.execute.return_value = _resp([])
    db.table.return_value.update.return_value.eq.return_value.execute.return_value = _resp([])

    with _patch_db(db):
        resp = client.post("/teams/accept-invites", json={
            "user_id": INVITEE_ID,
            "email": INVITEE_EMAIL,
        })

    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] == 1
    assert ORG_ID in body["team_ids"]


# ---------------------------------------------------------------------------
# 7. accept-invites: no pending invites returns accepted=0
# ---------------------------------------------------------------------------

def test_accept_invites_no_pending(client):
    db = MagicMock()
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value = _resp([])

    with _patch_db(db):
        resp = client.post("/teams/accept-invites", json={
            "user_id": INVITEE_ID,
            "email": "nobody@example.com",
        })

    assert resp.status_code == 200
    assert resp.json()["accepted"] == 0


# ---------------------------------------------------------------------------
# 8. create_team: response my_role is readable text, not UUID
# ---------------------------------------------------------------------------

def test_create_team_inserts_owner_role_as_uuid(client):
    db = MagicMock()

    # slug uniqueness check: no conflict
    db.table.return_value.select.return_value.eq.return_value.execute.return_value = _resp([])
    db.table.return_value.insert.return_value.execute.return_value = _resp([])

    with _patch_db(db):
        resp = client.post("/teams", json={
            "name": "My Team",
            "owner_id": OWNER_ID,
            "default_ai_model": "gpt-4o",
        })

    assert resp.status_code == 201
    body = resp.json()
    # my_role returned to client is still readable text
    assert body["my_role"] == "owner"

    # Find the team_members insert call and verify UUID role was used
    member_calls = [
        call.args[0]
        for call in db.table.return_value.insert.call_args_list
        if isinstance(call.args[0], dict) and "team_id" in call.args[0]
    ]
    assert member_calls, "Expected a team_members insert call"
    assert member_calls[0]["role"] == ROLE_OWNER, (
        f"Expected UUID {ROLE_OWNER!r}, got {member_calls[0]['role']!r}"
    )


# ---------------------------------------------------------------------------
# 9. invite_member_by_email: role stored as UUID in team_invites
# ---------------------------------------------------------------------------

def test_invite_stores_role_as_uuid(client):
    db = MagicMock()

    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(_ORG_ROW)
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"user_id": OWNER_ID}]
    )
    db.auth.admin.list_users.return_value = [_user(OWNER_ID, OWNER_EMAIL)]
    db.table.return_value.upsert.return_value.execute.return_value = _resp([])
    db.auth.admin.invite_user_by_email.return_value = None

    with _patch_db(db):
        with patch("app.api.teams.get_settings") as mock_settings:
            s = MagicMock()
            s.postmark_enabled = False
            mock_settings.return_value = s

            resp = client.post(f"/teams/{ORG_ID}/invites", json={
                "email": INVITEE_EMAIL,
                "role": "member",
                "invited_by_user_id": OWNER_ID,
            })

    assert resp.status_code == 201
    # Find the team_invites upsert — it's the call whose row has "email" key
    upsert_calls = [
        call.args[0]
        for call in db.table.return_value.upsert.call_args_list
        if isinstance(call.args[0], dict) and "email" in call.args[0]
    ]
    assert upsert_calls, "Expected a team_invites upsert call"
    assert upsert_calls[0]["role"] == ROLE_MEMBER, (
        f"Expected UUID {ROLE_MEMBER!r}, got {upsert_calls[0]['role']!r}"
    )
