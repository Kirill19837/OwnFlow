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
        [{"user_id": OWNER_ID, "role": ROLE_OWNER}]
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
        [{"user_id": OWNER_ID, "role": ROLE_OWNER}]
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
        [{"user_id": OWNER_ID, "role": ROLE_OWNER}]
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
        [{"user_id": OWNER_ID, "role": ROLE_OWNER}]
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
# 8. accept-invites: user is added to the exact team they were invited to
# ---------------------------------------------------------------------------

def test_accept_invite_joins_correct_team(client):
    """
    The user must be inserted into team_members with exactly the team_id from
    the pending invite row — not some other team — and with the matching role UUID.
    Uses per-table mocks so we can inspect each table's calls independently.
    """
    COMPANY_ID = str(uuid.uuid4())
    INVITE_ID = str(uuid.uuid4())

    # Build one mock per table so we can check each independently.
    team_invites_mock = MagicMock()
    teams_mock = MagicMock()
    team_members_mock = MagicMock()
    company_members_mock = MagicMock()
    user_signups_mock = MagicMock()

    def _table(name: str):
        return {
            "team_invites": team_invites_mock,
            "teams": teams_mock,
            "team_members": team_members_mock,
            "company_members": company_members_mock,
            "user_signups": user_signups_mock,
        }.get(name, MagicMock())

    db = MagicMock()
    db.table.side_effect = _table

    # One pending invite for ORG_ID with ROLE_MEMBER
    team_invites_mock.select.return_value.eq.return_value.eq.return_value.execute.return_value = _resp([
        {"id": INVITE_ID, "team_id": ORG_ID, "role": ROLE_MEMBER},
    ])
    team_invites_mock.update.return_value.eq.return_value.execute.return_value = _resp([])

    # ORG_ID belongs to COMPANY_ID
    teams_mock.select.return_value.in_.return_value.execute.return_value = _resp([
        {"id": ORG_ID, "company_id": COMPANY_ID},
    ])

    # No conflicting company memberships for this user
    company_members_mock.select.return_value.eq.return_value.neq.return_value.execute.return_value = _resp([])
    company_members_mock.upsert.return_value.execute.return_value = _resp([])

    team_members_mock.upsert.return_value.execute.return_value = _resp([])
    user_signups_mock.upsert.return_value.execute.return_value = _resp([])

    with _patch_db(db):
        resp = client.post("/teams/accept-invites", json={
            "user_id": INVITEE_ID,
            "email": INVITEE_EMAIL,
        })

    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] == 1
    assert ORG_ID in body["team_ids"]

    # team_members.upsert must have been called with the correct team, user, and role
    assert team_members_mock.upsert.called, "Expected team_members.upsert to be called"
    member_row = team_members_mock.upsert.call_args_list[0].args[0]
    assert member_row["team_id"] == ORG_ID, (
        f"Expected team_id={ORG_ID!r}, got {member_row.get('team_id')!r}"
    )
    assert member_row["user_id"] == INVITEE_ID, (
        f"Expected user_id={INVITEE_ID!r}, got {member_row.get('user_id')!r}"
    )
    assert member_row["role"] == ROLE_MEMBER, (
        f"Expected role UUID {ROLE_MEMBER!r}, got {member_row.get('role')!r}"
    )

    # team_invites must have been marked accepted for the right invite id
    assert team_invites_mock.update.called, "Expected team_invites.update to be called"
    update_row = team_invites_mock.update.call_args_list[0].args[0]
    assert update_row["status"] == "accepted"
    assert update_row.get("accepted_user_id") == INVITEE_ID


# ---------------------------------------------------------------------------
# 9. create_team: response my_role is readable text, not UUID
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
        [{"user_id": OWNER_ID, "role": ROLE_OWNER}]
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


# ---------------------------------------------------------------------------
# 10. member cannot invite (403)
# ---------------------------------------------------------------------------

def test_member_cannot_invite(client):
    db = MagicMock()

    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(_ORG_ROW)

    # inviter exists but has ROLE_MEMBER (not admin/owner)
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"user_id": INVITEE_ID, "role": ROLE_MEMBER}]
    )
    db.auth.admin.list_users.return_value = [_user(INVITEE_ID, INVITEE_EMAIL)]

    with _patch_db(db):
        with patch("app.api.teams.get_settings") as mock_settings:
            s = MagicMock()
            s.postmark_enabled = False
            mock_settings.return_value = s

            resp = client.post(f"/teams/{ORG_ID}/invites", json={
                "email": "new@example.com",
                "role": "member",
                "invited_by_user_id": INVITEE_ID,
            })

    assert resp.status_code == 403
    assert "admin" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# 11. Resend invite to unconfirmed user — must send invite email (not "added" email)
# ---------------------------------------------------------------------------

def test_resend_invite_to_unconfirmed_user_sends_invite_email(client):
    """
    When 'resend' re-calls POST /{team_id}/invites for a user whose first invite
    was never clicked (Supabase throws 'already been invited'), the backend must
    fall back to generate_link(type='magiclink') and send the proper invite email,
    NOT the 'added to org' notification email.
    """
    db = MagicMock()

    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(_ORG_ROW)
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"user_id": OWNER_ID, "role": ROLE_OWNER}]
    )

    owner_user = _user(OWNER_ID, OWNER_EMAIL)
    db.auth.admin.list_users.return_value = [owner_user]
    db.table.return_value.upsert.return_value.execute.return_value = _resp([])

    # First generate_link(type="invite") fails — user already has a pending invite
    magic_link_resp = SimpleNamespace(
        action_link="https://supabase.co/auth/confirm?token=magic123",
        properties=SimpleNamespace(action_link="https://supabase.co/auth/confirm?token=magic123"),
    )

    def generate_link_side_effect(payload):
        if payload.get("type") == "invite":
            raise Exception("User already been invited")
        return magic_link_resp

    db.auth.admin.generate_link.side_effect = generate_link_side_effect

    with _patch_db(db):
        with patch("app.api.teams.send_invite_email") as mock_invite_email:
            with patch("app.api.teams.send_added_to_org_email") as mock_added_email:
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
    # Must send the invite email with the magic link, not the "added" notification
    mock_invite_email.assert_called_once()
    mock_added_email.assert_not_called()
    call_kwargs = mock_invite_email.call_args.kwargs
    assert call_kwargs["to_email"] == INVITEE_EMAIL
    assert "magic123" in call_kwargs["invite_url"]


# ---------------------------------------------------------------------------
# 12. Resend to confirmed user — must send "added to org" notification (not invite)
# ---------------------------------------------------------------------------

def test_resend_invite_to_confirmed_user_sends_added_email(client):
    """
    When generate_link(type='invite') fails with 'already registered' (confirmed
    user), the backend must send send_added_to_org_email, NOT the invite email.
    """
    db = MagicMock()

    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(_ORG_ROW)
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"user_id": OWNER_ID, "role": ROLE_OWNER}]
    )

    existing = _user(INVITEE_ID, INVITEE_EMAIL, confirmed=True)
    owner_user = _user(OWNER_ID, OWNER_EMAIL)
    db.auth.admin.list_users.return_value = [owner_user, existing]
    db.table.return_value.upsert.return_value.execute.return_value = _resp([])

    db.auth.admin.generate_link.side_effect = Exception("User already registered")

    with _patch_db(db):
        with patch("app.api.teams.send_invite_email") as mock_invite_email:
            with patch("app.api.teams.send_added_to_org_email") as mock_added_email:
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
    mock_added_email.assert_called_once()
    mock_invite_email.assert_not_called()
    assert mock_added_email.call_args.kwargs["to_email"] == INVITEE_EMAIL


# ---------------------------------------------------------------------------
# 14. admin can invite (201)
# ---------------------------------------------------------------------------

def test_admin_can_invite(client):
    ADMIN_ID = str(uuid.uuid4())
    db = MagicMock()

    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(_ORG_ROW)

    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"user_id": ADMIN_ID, "role": ROLE_ADMIN}]
    )
    db.auth.admin.list_users.return_value = [_user(ADMIN_ID, "admin@example.com")]
    db.table.return_value.upsert.return_value.execute.return_value = _resp([])
    db.auth.admin.invite_user_by_email.return_value = None

    with _patch_db(db):
        with patch("app.api.teams.get_settings") as mock_settings:
            s = MagicMock()
            s.postmark_enabled = False
            mock_settings.return_value = s

            resp = client.post(f"/teams/{ORG_ID}/invites", json={
                "email": "new@example.com",
                "role": "member",
                "invited_by_user_id": ADMIN_ID,
            })

    assert resp.status_code == 201


# ---------------------------------------------------------------------------
# 15. get_role_name: unit tests for the helper function
# ---------------------------------------------------------------------------

def test_get_role_name_known_uuids():
    from app.api.teams import get_role_name, ROLE_IDS
    assert get_role_name(ROLE_IDS["owner"])  == "owner"
    assert get_role_name(ROLE_IDS["admin"])  == "admin"
    assert get_role_name(ROLE_IDS["member"]) == "member"


def test_get_role_name_unknown_uuid_returns_raw():
    from app.api.teams import get_role_name
    raw = "00000000-0000-0000-0000-000000000099"
    assert get_role_name(raw) == raw


def test_get_role_name_none_returns_fallback():
    from app.api.teams import get_role_name
    assert get_role_name(None) == "member"
    assert get_role_name(None, fallback="unknown") == "unknown"


def test_get_role_name_empty_string_returns_fallback():
    from app.api.teams import get_role_name
    assert get_role_name("") == "member"


# ---------------------------------------------------------------------------
# 16. get_team: pending_invites role resolved to name, role_id preserved
# ---------------------------------------------------------------------------

def test_get_team_pending_invites_resolve_role_name(client):
    """
    GET /teams/{id} must return pending_invites with role as a display name
    ('member', 'admin', 'owner'), not a raw UUID, and must include role_id
    with the original UUID.
    """
    INVITE_ID = str(uuid.uuid4())
    CALLER_ID = OWNER_ID

    db = MagicMock()

    # Team exists
    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(_ORG_ROW)

    # team_members: only the owner
    db.table.return_value.select.return_value.eq.return_value.execute.return_value = _resp([
        {"user_id": OWNER_ID, "role": ROLE_OWNER, "team_id": ORG_ID},
    ])

    # auth.admin.list_users for member email/name enrichment
    db.auth.admin.list_users.return_value = [_user(OWNER_ID, OWNER_EMAIL)]

    # pending_invites returns raw UUID role
    pending_resp = _resp([{
        "id": INVITE_ID,
        "email": INVITEE_EMAIL,
        "role": ROLE_MEMBER,
        "invited_by_email": OWNER_EMAIL,
        "status": "pending",
        "invited_at": "2026-04-28T00:00:00+00:00",
    }])
    # We need the pending query (filtered by team_id + status) to return this row.
    # The chain is: .select().eq(team_id).eq(status).order().execute()
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.order.return_value.execute.return_value = pending_resp

    with _patch_db(db):
        from app.main import app
        from app.auth_deps import current_user_id
        app.dependency_overrides[current_user_id] = lambda: CALLER_ID
        try:
            resp = client.get(f"/teams/{ORG_ID}")
        finally:
            app.dependency_overrides.pop(current_user_id, None)

    assert resp.status_code == 200
    body = resp.json()
    invites = body.get("pending_invites", [])
    assert len(invites) == 1, f"Expected 1 pending invite, got {invites}"
    inv = invites[0]
    assert inv["role"] == "member",   f"Expected 'member', got {inv['role']!r}"
    assert inv["role_id"] == ROLE_MEMBER, f"Expected UUID, got {inv['role_id']!r}"

# ---------------------------------------------------------------------------
# 15. non-owner cannot delete team (403)
# ---------------------------------------------------------------------------

def test_non_owner_cannot_delete_team(client):
    db = MagicMock()

    # admin member — not owner
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"role": ROLE_ADMIN}]
    )

    from app.main import app
    from app.auth_deps import current_user_id
    app.dependency_overrides[current_user_id] = lambda: INVITEE_ID
    try:
        with _patch_db(db):
            resp = client.delete(f"/teams/{ORG_ID}")
    finally:
        app.dependency_overrides.clear()

    assert resp.status_code == 403
    assert "owner" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# 16. GET /teams/pending-invite — returns invite details for pending email
# ---------------------------------------------------------------------------

def test_get_pending_invite_returns_invite(client):
    db = MagicMock()
    invite_id = str(uuid.uuid4())

    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp([
        {"id": invite_id, "team_id": ORG_ID, "role": ROLE_MEMBER, "invited_by_email": OWNER_EMAIL},
    ])
    db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(
        {"id": ORG_ID, "name": "Test Org"}
    )

    with _patch_db(db):
        resp = client.get("/teams/pending-invite", params={"email": INVITEE_EMAIL})

    assert resp.status_code == 200
    body = resp.json()
    assert body["invite"] is not None
    assert body["invite"]["team_name"] == "Test Org"
    assert body["invite"]["role"] == "member"
    assert body["invite"]["invited_by_email"] == OWNER_EMAIL
    assert body["invite"]["team_id"] == ORG_ID


def test_get_pending_invite_returns_null_when_none(client):
    db = MagicMock()
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp([])

    with _patch_db(db):
        resp = client.get("/teams/pending-invite", params={"email": "nobody@example.com"})

    assert resp.status_code == 200
    assert resp.json()["invite"] is None


# ---------------------------------------------------------------------------
# 17. owner can delete team (204)
# ---------------------------------------------------------------------------

def test_owner_can_delete_team(client):

    db = MagicMock()

    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"role": ROLE_OWNER}]
    )
    db.table.return_value.delete.return_value.eq.return_value.execute.return_value = _resp([])

    from app.main import app
    from app.auth_deps import current_user_id
    app.dependency_overrides[current_user_id] = lambda: OWNER_ID
    try:
        with _patch_db(db):
            resp = client.delete(f"/teams/{ORG_ID}")
    finally:
        app.dependency_overrides.clear()

    assert resp.status_code == 204


# ===========================================================================
# Company PATCH / DELETE endpoint tests
# ===========================================================================

COMPANY_ID   = str(uuid.uuid4())
COMPANY_ROW  = {"id": COMPANY_ID, "name": "Acme", "slug": "acme", "owner_id": OWNER_ID}

def _patch_company_db(db_mock):
    return patch("app.api.companies.get_supabase", return_value=db_mock)


def _company_owner_mock(user_id: str = OWNER_ID):
    """Return a db mock whose company_members lookup says user is owner."""
    db = MagicMock()
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"role": ROLE_OWNER}]
    )
    return db


def _company_member_mock(role_uuid: str):
    """Return a db mock whose company_members lookup returns the given role."""
    db = MagicMock()
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"role": role_uuid}]
    )
    return db


def _company_non_member_mock():
    """Return a db mock where the user is NOT a company member."""
    db = MagicMock()
    db.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp([])
    return db


# ---------------------------------------------------------------------------
# 18. PATCH /companies/{id} — owner can rename
# ---------------------------------------------------------------------------

def test_update_company_owner_can_rename(client):
    db = _company_owner_mock()
    db.table.return_value.update.return_value.eq.return_value.execute.return_value = _resp([])

    with _patch_company_db(db):
        resp = client.patch(
            f"/companies/{COMPANY_ID}",
            json={"name": "NewName"},
            params={"user_id": OWNER_ID},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "NewName"
    assert body["company_id"] == COMPANY_ID


# ---------------------------------------------------------------------------
# 19. PATCH /companies/{id} — owner can update phone
# ---------------------------------------------------------------------------

def test_update_company_owner_can_update_phone(client):
    db = _company_owner_mock()
    db.table.return_value.update.return_value.eq.return_value.execute.return_value = _resp([])

    with _patch_company_db(db):
        resp = client.patch(
            f"/companies/{COMPANY_ID}",
            json={"phone": "+1-555-0100"},
            params={"user_id": OWNER_ID},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["phone"] == "+1-555-0100"


# ---------------------------------------------------------------------------
# 20. PATCH /companies/{id} — non-owner (admin) gets 403
# ---------------------------------------------------------------------------

def test_update_company_admin_gets_403(client):
    db = _company_member_mock(ROLE_ADMIN)

    with _patch_company_db(db):
        resp = client.patch(
            f"/companies/{COMPANY_ID}",
            json={"name": "Hack"},
            params={"user_id": INVITEE_ID},
        )

    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 21. PATCH /companies/{id} — non-member gets 403
# ---------------------------------------------------------------------------

def test_update_company_non_member_gets_403(client):
    db = _company_non_member_mock()

    with _patch_company_db(db):
        resp = client.patch(
            f"/companies/{COMPANY_ID}",
            json={"name": "Hack"},
            params={"user_id": str(uuid.uuid4())},
        )

    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 22. PATCH /companies/{id} — empty body returns 400
# ---------------------------------------------------------------------------

def test_update_company_empty_body_returns_400(client):
    db = _company_owner_mock()

    with _patch_company_db(db):
        resp = client.patch(
            f"/companies/{COMPANY_ID}",
            json={},
            params={"user_id": OWNER_ID},
        )

    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 23. DELETE /companies/{id} — owner can delete; cascade calls are made
# ---------------------------------------------------------------------------

def test_delete_company_owner_cascades_and_returns_204(client):
    company_members_mock = MagicMock()
    teams_mock           = MagicMock()
    team_members_mock    = MagicMock()
    team_invites_mock    = MagicMock()
    companies_mock       = MagicMock()

    # _require_company_owner lookup
    company_members_mock.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        [{"role": ROLE_OWNER}]
    )

    TEAM_ID_1 = str(uuid.uuid4())
    TEAM_ID_2 = str(uuid.uuid4())

    # list teams belonging to company
    teams_mock.select.return_value.eq.return_value.execute.return_value = _resp([
        {"id": TEAM_ID_1},
        {"id": TEAM_ID_2},
    ])

    # All delete operations succeed
    team_invites_mock.delete.return_value.eq.return_value.execute.return_value = _resp([])
    team_members_mock.delete.return_value.eq.return_value.execute.return_value = _resp([])
    teams_mock.delete.return_value.eq.return_value.execute.return_value       = _resp([])
    company_members_mock.delete.return_value.eq.return_value.execute.return_value = _resp([])
    companies_mock.delete.return_value.eq.return_value.execute.return_value   = _resp([])

    def _table(name: str):
        return {
            "company_members": company_members_mock,
            "teams":           teams_mock,
            "team_members":    team_members_mock,
            "team_invites":    team_invites_mock,
            "companies":       companies_mock,
        }.get(name, MagicMock())

    db = MagicMock()
    db.table.side_effect = _table

    with _patch_company_db(db):
        resp = client.delete(
            f"/companies/{COMPANY_ID}",
            params={"user_id": OWNER_ID},
        )

    assert resp.status_code == 204

    # Verify team-level cascade: team_invites and team_members deleted for each team
    assert team_invites_mock.delete.call_count == 2
    assert team_members_mock.delete.call_count == 2
    assert teams_mock.delete.call_count == 2

    # Verify company-level cleanup
    assert company_members_mock.delete.call_count == 1
    assert companies_mock.delete.call_count == 1


# ---------------------------------------------------------------------------
# 24. DELETE /companies/{id} — non-owner gets 403
# ---------------------------------------------------------------------------

def test_delete_company_non_owner_gets_403(client):
    db = _company_member_mock(ROLE_MEMBER)

    with _patch_company_db(db):
        resp = client.delete(
            f"/companies/{COMPANY_ID}",
            params={"user_id": INVITEE_ID},
        )

    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 25. DELETE /companies/{id} — non-member gets 403
# ---------------------------------------------------------------------------

def test_delete_company_non_member_gets_403(client):
    db = _company_non_member_mock()

    with _patch_company_db(db):
        resp = client.delete(
            f"/companies/{COMPANY_ID}",
            params={"user_id": str(uuid.uuid4())},
        )

    assert resp.status_code == 403

