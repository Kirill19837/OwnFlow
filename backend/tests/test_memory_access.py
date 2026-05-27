from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.auth_deps import current_user_id
from app.main import app

PROJECT_ID = "11111111-1111-1111-1111-111111111111"
OWNER_ID = "22222222-2222-2222-2222-222222222222"
MEMBER_ID = "33333333-3333-3333-3333-333333333333"
OUTSIDER_ID = "44444444-4444-4444-4444-444444444444"
TEAM_ID = "55555555-5555-5555-5555-555555555555"


def _resp(data):
    r = MagicMock()
    r.data = data
    return r


@pytest.fixture()
def client():
    with TestClient(app, raise_server_exceptions=True) as tc:
        yield tc
    app.dependency_overrides.clear()


def _db_for_project_access(*, owner_id: str, team_id: str | None, member_rows: list[dict], chunks: list[dict] | None = None):
    db = MagicMock()

    projects_table = MagicMock()
    projects_table.select.return_value.eq.return_value.single.return_value.execute.return_value = _resp(
        {"id": PROJECT_ID, "owner_id": owner_id, "team_id": team_id}
    )

    team_members_table = MagicMock()
    team_members_table.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = _resp(
        member_rows
    )

    memory_chunks_table = MagicMock()
    mem_eq = memory_chunks_table.select.return_value.eq.return_value
    mem_eq.order.return_value.order.return_value.execute.return_value = _resp(chunks or [])

    def table_side_effect(name: str):
        if name == "projects":
            return projects_table
        if name == "team_members":
            return team_members_table
        if name == "memory_chunks":
            return memory_chunks_table
        return MagicMock()

    db.table.side_effect = table_side_effect
    return db


def test_memory_list_allows_project_owner(client: TestClient):
    app.dependency_overrides[current_user_id] = lambda: OWNER_ID
    db = _db_for_project_access(owner_id=OWNER_ID, team_id=TEAM_ID, member_rows=[], chunks=[{"id": "c1", "project_id": PROJECT_ID}])

    with patch("app.api.memory.get_supabase", return_value=db):
        resp = client.get(f"/projects/{PROJECT_ID}/memory")

    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
    assert len(resp.json()) == 1


def test_memory_list_allows_team_member(client: TestClient):
    app.dependency_overrides[current_user_id] = lambda: MEMBER_ID
    db = _db_for_project_access(
        owner_id=OWNER_ID,
        team_id=TEAM_ID,
        member_rows=[{"user_id": MEMBER_ID}],
        chunks=[{"id": "c1", "project_id": PROJECT_ID}],
    )

    with patch("app.api.memory.get_supabase", return_value=db):
        resp = client.get(f"/projects/{PROJECT_ID}/memory")

    assert resp.status_code == 200
    assert len(resp.json()) == 1


def test_memory_list_forbids_outsider(client: TestClient):
    app.dependency_overrides[current_user_id] = lambda: OUTSIDER_ID
    db = _db_for_project_access(owner_id=OWNER_ID, team_id=TEAM_ID, member_rows=[])

    with patch("app.api.memory.get_supabase", return_value=db):
        resp = client.get(f"/projects/{PROJECT_ID}/memory")

    assert resp.status_code == 403
    assert "do not have access" in resp.json()["detail"]


def test_memory_upload_forbids_outsider(client: TestClient):
    app.dependency_overrides[current_user_id] = lambda: OUTSIDER_ID
    db = _db_for_project_access(owner_id=OWNER_ID, team_id=TEAM_ID, member_rows=[])

    with patch("app.api.memory.get_supabase", return_value=db):
        resp = client.post(
            f"/projects/{PROJECT_ID}/memory/upload-documents",
            files=[("files", ("notes.txt", b"hello", "text/plain"))],
        )

    assert resp.status_code == 403
    assert "do not have access" in resp.json()["detail"]
