"""
Tests for POST /agents/callback

Covers:
- Missing / malformed Authorization header → 401
- Empty token → 401
- Task not found → 404
- Invalid token (wrong value) → 403
- Success path: deliverable saved, task status updated, logs+messages persisted
- Files present → create_pr_for_task called
- Files absent → create_pr_for_task NOT called
- Consumed token (race / duplicate callback) → 409
- logs with ERROR keyword → level="error" in ai_logs
"""
from __future__ import annotations

import json
import uuid
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest
from starlette.testclient import TestClient

# ---------------------------------------------------------------------------
# App under test (mounted under /agents prefix as in production)
# ---------------------------------------------------------------------------
from fastapi import FastAPI
from app.api.agents import router

_test_app = FastAPI()
_test_app.include_router(router, prefix="/agents")
client = TestClient(_test_app, raise_server_exceptions=False)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TASK_ID = str(uuid.uuid4())
PROJECT_ID = str(uuid.uuid4())
ACTOR_ID = str(uuid.uuid4())
VALID_TOKEN = "abc123validtoken"

BASE_TASK = {
    "id": TASK_ID,
    "project_id": PROJECT_ID,
    "title": "Build login page",
    "agent_callback_token": VALID_TOKEN,
    "assignments": [{"actor_id": ACTOR_ID}],
}

BASE_BODY = {
    "task_id": TASK_ID,
    "content": "Here is the deliverable.",
}


def _resp(data):
    r = MagicMock()
    r.data = data
    return r


def _make_db(task=None, consume_returns_data=True):
    """
    Build a mock Supabase client for the callback endpoint.

    task=None  → task lookup returns no data (404 path)
    consume_returns_data=False → atomic UPDATE returns empty list (409 path)
    """
    db = MagicMock()
    deliverable_inserts = []
    ai_log_inserts = []
    ai_message_inserts = []

    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.update.return_value = t

        if name == "tasks":
            # .select().eq().single().execute() → task lookup
            # .update().eq().eq().execute()      → atomic token consumption
            lookup_result = _resp(task)

            def eq_side_effect(*a, **kw):
                inner = MagicMock()
                inner.eq.return_value = inner
                inner.single.return_value = MagicMock(execute=MagicMock(return_value=lookup_result))
                # For the update chain: .update().eq().eq().execute()
                inner.execute = MagicMock(
                    return_value=_resp([task] if consume_returns_data else [])
                )
                return inner

            t.select.return_value = MagicMock(
                eq=MagicMock(return_value=MagicMock(
                    single=MagicMock(return_value=MagicMock(
                        execute=MagicMock(return_value=lookup_result)
                    ))
                ))
            )
            update_chain = MagicMock()
            update_chain.eq.return_value = update_chain
            update_chain.execute = MagicMock(
                return_value=_resp([task] if consume_returns_data else [])
            )
            t.update.return_value = update_chain

        elif name == "deliverables":
            ins = MagicMock()
            ins.execute = MagicMock(return_value=_resp(None))

            def capture(row):
                deliverable_inserts.append(row)
                return ins

            t.insert.side_effect = capture

        elif name == "ai_logs":
            ins = MagicMock()
            ins.execute = MagicMock(return_value=_resp(None))

            def capture(row):
                ai_log_inserts.append(row)
                return ins

            t.insert.side_effect = capture

        elif name == "ai_messages":
            ins = MagicMock()
            ins.execute = MagicMock(return_value=_resp(None))

            def capture(row):
                ai_message_inserts.append(row)
                return ins

            t.insert.side_effect = capture

        else:
            t.execute.return_value = _resp(None)

        return t

    db.table.side_effect = table
    db._deliverable_inserts = deliverable_inserts
    db._ai_log_inserts = ai_log_inserts
    db._ai_message_inserts = ai_message_inserts
    return db


def _post(body=None, token=VALID_TOKEN, auth_header=None):
    headers = {}
    if auth_header is not None:
        headers["Authorization"] = auth_header
    elif token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return client.post("/agents/callback", json=body or BASE_BODY, headers=headers)


# ---------------------------------------------------------------------------
# Auth / header validation
# ---------------------------------------------------------------------------

def test_missing_auth_header_returns_401():
    resp = _post(auth_header="")
    assert resp.status_code == 401


def test_non_bearer_scheme_returns_401():
    resp = _post(auth_header="Basic sometoken")
    assert resp.status_code == 401


def test_empty_bearer_token_returns_401():
    resp = _post(auth_header="Bearer ")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Task lookup
# ---------------------------------------------------------------------------

def test_unknown_task_id_returns_404():
    db = _make_db(task=None)
    with patch("app.api.agents.get_supabase", return_value=db):
        resp = _post()
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Token validation
# ---------------------------------------------------------------------------

def test_wrong_token_returns_403():
    db = _make_db(task=BASE_TASK)
    with patch("app.api.agents.get_supabase", return_value=db):
        resp = _post(token="wrong-token")
    assert resp.status_code == 403


def test_task_without_stored_token_returns_403():
    task_no_token = {**BASE_TASK, "agent_callback_token": None}
    db = _make_db(task=task_no_token)
    with patch("app.api.agents.get_supabase", return_value=db):
        resp = _post()
    assert resp.status_code == 403


def test_missing_assignment_returns_400_before_token_consumed():
    """actor_id is NOT NULL in DB; missing assignment must 400 before the token is consumed."""
    task_no_assign = {**BASE_TASK, "assignments": []}
    db = _make_db(task=task_no_assign)
    with patch("app.api.agents.get_supabase", return_value=db):
        resp = _post()
    assert resp.status_code == 400
    # Token must NOT have been consumed (update chain should not have been called)
    db.table("tasks").update.assert_not_called()


# ---------------------------------------------------------------------------
# Duplicate / already-consumed token → 409
# ---------------------------------------------------------------------------

def test_consumed_token_returns_409():
    db = _make_db(task=BASE_TASK, consume_returns_data=False)
    with patch("app.api.agents.get_supabase", return_value=db):
        resp = _post()
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Success path
# ---------------------------------------------------------------------------

def test_success_returns_ok_and_task_id():
    db = _make_db(task=BASE_TASK)
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", new_callable=AsyncMock):
        resp = _post()
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["task_id"] == TASK_ID


def test_success_inserts_deliverable():
    db = _make_db(task=BASE_TASK)
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", new_callable=AsyncMock):
        _post()
    assert len(db._deliverable_inserts) == 1
    row = db._deliverable_inserts[0]
    assert row["task_id"] == TASK_ID
    assert row["content"] == BASE_BODY["content"]
    assert row["actor_id"] == ACTOR_ID


def test_success_resolves_actor_id_from_list_assignment():
    task = {**BASE_TASK, "assignments": [{"actor_id": ACTOR_ID}]}
    db = _make_db(task=task)
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", new_callable=AsyncMock):
        _post()
    assert db._deliverable_inserts[0]["actor_id"] == ACTOR_ID


def test_success_resolves_actor_id_from_dict_assignment():
    task = {**BASE_TASK, "assignments": {"actor_id": ACTOR_ID}}
    db = _make_db(task=task)
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", new_callable=AsyncMock):
        _post()
    assert db._deliverable_inserts[0]["actor_id"] == ACTOR_ID


# ---------------------------------------------------------------------------
# Logs persistence
# ---------------------------------------------------------------------------

def test_logs_are_persisted_to_ai_logs():
    body = {**BASE_BODY, "logs": ["[10:00:00] [INFO] started", "[10:00:01] [INFO] done"]}
    db = _make_db(task=BASE_TASK)
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", new_callable=AsyncMock):
        resp = _post(body=body)
    assert resp.status_code == 200
    assert len(db._ai_log_inserts) == 2
    assert db._ai_log_inserts[0]["message"] == "[10:00:00] [INFO] started"
    assert db._ai_log_inserts[0]["level"] == "info"


def test_error_log_line_gets_level_error():
    body = {**BASE_BODY, "logs": ["[10:00:02] [ERROR] something failed"]}
    db = _make_db(task=BASE_TASK)
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", new_callable=AsyncMock):
        _post(body=body)
    assert db._ai_log_inserts[0]["level"] == "error"


def test_no_logs_field_skips_ai_logs():
    db = _make_db(task=BASE_TASK)
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", new_callable=AsyncMock):
        _post()
    assert db._ai_log_inserts == []


# ---------------------------------------------------------------------------
# ai_messages persistence
# ---------------------------------------------------------------------------

def test_prompt_and_model_persisted_to_ai_messages():
    body = {**BASE_BODY, "prompt": "Do the thing", "model": "gpt-4o"}
    db = _make_db(task=BASE_TASK)
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", new_callable=AsyncMock):
        _post(body=body)
    assert len(db._ai_message_inserts) == 1
    row = db._ai_message_inserts[0]
    assert row["model"] == "gpt-4o"
    assert row["messages"][0]["content"] == "Do the thing"
    assert row["response"] == BASE_BODY["content"]


def test_missing_model_skips_ai_messages():
    body = {**BASE_BODY, "prompt": "Do the thing"}  # no model
    db = _make_db(task=BASE_TASK)
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", new_callable=AsyncMock):
        _post(body=body)
    assert db._ai_message_inserts == []


# ---------------------------------------------------------------------------
# GitHub PR
# ---------------------------------------------------------------------------

def test_files_present_calls_create_pr():
    body = {**BASE_BODY, "files": [{"path": "src/x.py", "content": "print(1)"}]}
    db = _make_db(task=BASE_TASK)
    pr_mock = AsyncMock()
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", pr_mock):
        _post(body=body)
    pr_mock.assert_awaited_once()
    call_args = pr_mock.call_args
    assert call_args[0][0] == TASK_ID  # task_id
    assert "###FILES###" in call_args[0][2]  # content_with_files


def test_pr_url_present_skips_create_pr():
    """Agent already created a PR — callback handler must not create a second one."""
    body = {
        **BASE_BODY,
        "files": [{"path": "src/x.py", "content": "print(1)"}],
        "pr_url": "https://github.com/owner/repo/pull/42",
    }
    db = _make_db(task=BASE_TASK)
    pr_mock = AsyncMock()
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", pr_mock):
        resp = _post(body=body)
    assert resp.status_code == 200
    pr_mock.assert_not_awaited()


def test_existing_files_block_in_content_is_stripped_before_appending():
    """If the agent already embedded ###FILES### in body.content, only one block must reach create_pr_for_task."""
    stale_block = '###FILES###\n[{"path": "old.py", "content": "stale"}]'
    body = {
        **BASE_BODY,
        "content": f"Some narrative.\n\n{stale_block}",
        "files": [{"path": "src/x.py", "content": "print(1)"}],
    }
    db = _make_db(task=BASE_TASK)
    pr_mock = AsyncMock()
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", pr_mock):
        _post(body=body)
    passed_content = pr_mock.call_args[0][2]
    assert passed_content.count("###FILES###") == 1
    assert "old.py" not in passed_content
    assert "src/x.py" in passed_content


def test_no_files_skips_create_pr():
    db = _make_db(task=BASE_TASK)
    pr_mock = AsyncMock()
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", pr_mock):
        _post()
    pr_mock.assert_not_awaited()


def test_pr_failure_does_not_fail_callback():
    body = {**BASE_BODY, "files": [{"path": "a.py", "content": "x=1"}]}
    db = _make_db(task=BASE_TASK)
    pr_mock = AsyncMock(side_effect=Exception("GitHub down"))
    with patch("app.api.agents.get_supabase", return_value=db), \
         patch("app.api.agents.create_pr_for_task", pr_mock):
        resp = _post(body=body)
    assert resp.status_code == 200
