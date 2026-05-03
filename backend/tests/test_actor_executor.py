"""
Tests for actor_executor dispatch logic.

All Supabase DB calls, Docker subprocess, httpx, and GitHub service calls
are mocked — no real DB, network, or Docker daemon required.
"""
from __future__ import annotations

import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch, call

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TASK_ID    = str(uuid.uuid4())
ACTOR_ID   = str(uuid.uuid4())
PROJECT_ID = str(uuid.uuid4())
COMPANY_ID = str(uuid.uuid4())

TASK = {
    "id": TASK_ID,
    "project_id": PROJECT_ID,
    "title": "Build login page",
    "description": "Implement JWT login",
    "type": "code",
    "priority": "high",
    "status": "todo",
}

ACTOR_DOCKER = {
    "id": ACTOR_ID,
    "name": "Senior Dev",
    "type": "ai",
    "model": "gpt-4o",
    "webhook_url": None,
    "agent_api_key": None,
}

ACTOR_WEBHOOK = {
    "id": ACTOR_ID,
    "name": "External Dev",
    "type": "ai",
    "model": None,
    "webhook_url": "https://agent.example.com/run",
    "agent_api_key": "secret-key",
}

PROJECT = {
    "id": PROJECT_ID,
    "company_id": COMPANY_ID,
    "name": "My SaaS",
    "prompt": "A project management tool",
}


def _resp(data):
    r = MagicMock()
    r.data = data
    return r


def _db_mock(task=TASK, actor=ACTOR_DOCKER, project=PROJECT, company=None):
    """Return a mock Supabase client wired up for the standard execute_task path."""
    db = MagicMock()

    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.update.return_value = t
        t.insert.return_value = t
        t.delete.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.order.return_value = t

        if name == "tasks":
            t.execute.return_value = _resp(task)
        elif name == "actors":
            t.execute.return_value = _resp(actor)
        elif name == "projects":
            t.execute.return_value = _resp(project)
        elif name == "companies":
            t.execute.return_value = _resp(company or {})
        elif name == "deliverables":
            t.execute.return_value = _resp([])
        else:
            t.execute.return_value = _resp(None)

        return t

    db.table.side_effect = table
    return db


# ---------------------------------------------------------------------------
# execute_task — routes to Docker when no webhook_url
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_execute_task_routes_to_docker_when_no_webhook():
    db = _db_mock(actor=ACTOR_DOCKER)

    with patch("app.services.actor_executor.get_supabase", return_value=db), \
         patch("app.services.actor_executor._dispatch_docker_agent", new_callable=AsyncMock) as mock_docker, \
         patch("app.services.actor_executor._dispatch_external_agent", new_callable=AsyncMock) as mock_webhook:

        mock_docker.return_value = {"task_id": TASK_ID, "dispatched": True, "via": "docker"}

        from app.services.actor_executor import execute_task
        result = await execute_task(TASK_ID, ACTOR_ID)

        mock_docker.assert_awaited_once()
        mock_webhook.assert_not_awaited()
        assert result["via"] == "docker"


@pytest.mark.asyncio
async def test_execute_task_routes_to_webhook_when_webhook_url_set():
    db = _db_mock(actor=ACTOR_WEBHOOK)

    with patch("app.services.actor_executor.get_supabase", return_value=db), \
         patch("app.services.actor_executor._dispatch_external_agent", new_callable=AsyncMock) as mock_webhook, \
         patch("app.services.actor_executor._dispatch_docker_agent", new_callable=AsyncMock) as mock_docker:

        mock_webhook.return_value = {"task_id": TASK_ID, "dispatched": True}

        from app.services.actor_executor import execute_task
        result = await execute_task(TASK_ID, ACTOR_ID)

        mock_webhook.assert_awaited_once()
        mock_docker.assert_not_awaited()


@pytest.mark.asyncio
async def test_execute_task_raises_when_task_not_found():
    db = _db_mock()
    db.table("tasks").execute.return_value = _resp(None)

    # Rebuild side_effect so tasks returns None
    real_db = MagicMock()

    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.execute.return_value = _resp(None)
        return t

    real_db.table.side_effect = table

    with patch("app.services.actor_executor.get_supabase", return_value=real_db):
        from app.services.actor_executor import execute_task
        with pytest.raises(ValueError, match="not found"):
            await execute_task(TASK_ID, ACTOR_ID)


# ---------------------------------------------------------------------------
# _dispatch_docker_agent
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_dispatch_docker_sets_task_in_progress():
    db = _db_mock()
    update_mock = MagicMock()
    update_mock.eq.return_value = update_mock
    update_mock.execute.return_value = _resp(None)

    captured_update = {}

    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.order.return_value = t
        t.execute.return_value = _resp({} if name == "companies" else None)

        if name == "tasks":
            def capture_update(data):
                captured_update.update(data)
                t2 = MagicMock()
                t2.eq.return_value = t2
                t2.execute.return_value = _resp(None)
                return t2
            t.update.side_effect = capture_update
        return t

    real_db = MagicMock()
    real_db.table.side_effect = table

    proc_mock = AsyncMock()
    proc_mock.returncode = 0
    proc_mock.communicate = AsyncMock(return_value=(b"container-id\n", b""))

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value=None), \
         patch("app.services.actor_executor.get_settings") as mock_settings, \
         patch("app.services.actor_executor.asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=proc_mock):

        mock_settings.return_value.backend_url = "https://ownflow.example.com/api"
        mock_settings.return_value.builtin_agent_image = "ownflow-agent:latest"
        mock_settings.return_value.openai_api_key = "sk-test"
        mock_settings.return_value.anthropic_api_key = ""

        from app.services.actor_executor import _dispatch_docker_agent
        result = await _dispatch_docker_agent(TASK, ACTOR_DOCKER, PROJECT, real_db)

    assert captured_update["status"] == "in_progress"
    assert "agent_callback_token" in captured_update
    assert len(captured_update["agent_callback_token"]) == 64
    assert result["via"] == "docker"


@pytest.mark.asyncio
async def test_dispatch_docker_payload_contains_required_fields():
    """Verify the PAYLOAD env var passed to docker contains all contract fields."""
    proc_mock = AsyncMock()
    proc_mock.returncode = 0
    proc_mock.communicate = AsyncMock(return_value=(b"cid\n", b""))

    captured_cmd: list[str] = []

    async def fake_exec(*args, **kwargs):
        captured_cmd.extend(args)
        return proc_mock

    db = _db_mock()

    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.update.return_value = t
        t.execute.return_value = _resp({} if name == "companies" else None)
        return t

    real_db = MagicMock()
    real_db.table.side_effect = table

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value={"owner": "acme", "repo": "app", "token": "ghp_test"}), \
         patch("app.services.actor_executor.get_settings") as mock_settings, \
         patch("app.services.actor_executor.asyncio.create_subprocess_exec", side_effect=fake_exec):

        mock_settings.return_value.backend_url = "https://ownflow.example.com/api"
        mock_settings.return_value.builtin_agent_image = "ownflow-agent:latest"
        mock_settings.return_value.openai_api_key = "sk-openai"
        mock_settings.return_value.anthropic_api_key = ""

        from app.services.actor_executor import _dispatch_docker_agent
        await _dispatch_docker_agent(TASK, ACTOR_DOCKER, PROJECT, real_db)

    # Find PAYLOAD value in the docker command
    payload_str = None
    for i, arg in enumerate(captured_cmd):
        if arg.startswith("PAYLOAD="):
            payload_str = arg[len("PAYLOAD="):]
            break

    assert payload_str is not None, "PAYLOAD env var not found in docker command"
    payload = json.loads(payload_str)

    assert payload["task_id"] == TASK_ID
    assert "callback_url" in payload
    assert "callback_token" in payload
    assert payload["task"]["title"] == TASK["title"]
    assert payload["project"]["name"] == PROJECT["name"]
    assert payload["github"]["repo"] == "acme/app"
    assert payload["model"] == ACTOR_DOCKER["model"]


@pytest.mark.asyncio
async def test_dispatch_docker_logs_error_on_nonzero_exit():
    proc_mock = AsyncMock()
    proc_mock.returncode = 1
    proc_mock.communicate = AsyncMock(return_value=(b"", b"image not found"))

    logged = {}

    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.update.return_value = t

        if name == "ai_logs":
            def capture_insert(data):
                logged.update(data)
                m = MagicMock()
                m.execute.return_value = _resp(None)
                return m
            t.insert.side_effect = capture_insert
        else:
            t.execute.return_value = _resp({} if name == "companies" else None)
        return t

    real_db = MagicMock()
    real_db.table.side_effect = table

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value=None), \
         patch("app.services.actor_executor.get_settings") as mock_settings, \
         patch("app.services.actor_executor.asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=proc_mock):

        mock_settings.return_value.backend_url = ""
        mock_settings.return_value.builtin_agent_image = "ownflow-agent:latest"
        mock_settings.return_value.openai_api_key = ""
        mock_settings.return_value.anthropic_api_key = ""

        from app.services.actor_executor import _dispatch_docker_agent
        result = await _dispatch_docker_agent(TASK, ACTOR_DOCKER, PROJECT, real_db)

    assert logged.get("level") == "error"
    assert "image not found" in logged.get("message", "")
    # Still returns dispatched dict — caller doesn't hard-fail
    assert result["task_id"] == TASK_ID


# ---------------------------------------------------------------------------
# _dispatch_external_agent
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_dispatch_external_posts_to_webhook_url():
    db = _db_mock(actor=ACTOR_WEBHOOK)

    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.update.return_value = t
        t.insert.return_value = t
        t.execute.return_value = _resp(None)
        return t

    real_db = MagicMock()
    real_db.table.side_effect = table

    http_mock = AsyncMock()
    http_mock.__aenter__ = AsyncMock(return_value=http_mock)
    http_mock.__aexit__ = AsyncMock(return_value=False)
    http_mock.post = AsyncMock(return_value=MagicMock(status_code=200))

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value=None), \
         patch("app.services.actor_executor.get_settings") as mock_settings, \
         patch("app.services.actor_executor.httpx.AsyncClient", return_value=http_mock):

        mock_settings.return_value.backend_url = "https://ownflow.example.com/api"

        from app.services.actor_executor import _dispatch_external_agent
        result = await _dispatch_external_agent(TASK, ACTOR_WEBHOOK, PROJECT, real_db)

    http_mock.post.assert_awaited_once()
    call_args = http_mock.post.call_args
    assert call_args[0][0] == ACTOR_WEBHOOK["webhook_url"]
    headers = call_args[1]["headers"]
    assert headers["X-Api-Key"] == ACTOR_WEBHOOK["agent_api_key"]
    assert result["dispatched"] is True


@pytest.mark.asyncio
async def test_dispatch_external_logs_on_http_failure():
    logged = {}

    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.update.return_value = t

        if name == "ai_logs":
            def capture_insert(data):
                logged.update(data)
                m = MagicMock()
                m.execute.return_value = _resp(None)
                return m
            t.insert.side_effect = capture_insert
        else:
            t.execute.return_value = _resp(None)
        return t

    real_db = MagicMock()
    real_db.table.side_effect = table

    http_mock = AsyncMock()
    http_mock.__aenter__ = AsyncMock(return_value=http_mock)
    http_mock.__aexit__ = AsyncMock(return_value=False)
    http_mock.post = AsyncMock(side_effect=Exception("connection refused"))

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value=None), \
         patch("app.services.actor_executor.get_settings") as mock_settings, \
         patch("app.services.actor_executor.httpx.AsyncClient", return_value=http_mock):

        mock_settings.return_value.backend_url = ""

        from app.services.actor_executor import _dispatch_external_agent
        result = await _dispatch_external_agent(TASK, ACTOR_WEBHOOK, PROJECT, real_db)

    # Should not raise — logs and returns dispatched
    assert result["dispatched"] is True
    assert logged.get("level") == "error"
    assert "connection refused" in logged.get("message", "")


@pytest.mark.asyncio
async def test_dispatch_external_no_api_key_header_when_not_set():
    actor_no_key = {**ACTOR_WEBHOOK, "agent_api_key": None}

    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.update.return_value = t
        t.execute.return_value = _resp(None)
        return t

    real_db = MagicMock()
    real_db.table.side_effect = table

    http_mock = AsyncMock()
    http_mock.__aenter__ = AsyncMock(return_value=http_mock)
    http_mock.__aexit__ = AsyncMock(return_value=False)
    http_mock.post = AsyncMock(return_value=MagicMock(status_code=200))

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value=None), \
         patch("app.services.actor_executor.get_settings") as mock_settings, \
         patch("app.services.actor_executor.httpx.AsyncClient", return_value=http_mock):

        mock_settings.return_value.backend_url = ""

        from app.services.actor_executor import _dispatch_external_agent
        await _dispatch_external_agent(TASK, actor_no_key, PROJECT, real_db)

    headers = http_mock.post.call_args[1]["headers"]
    assert "X-Api-Key" not in headers


@pytest.mark.asyncio
async def test_dispatch_external_uses_company_level_callback_url():
    """callback_url in payload uses backend_url from settings."""
    captured_payload = {}

    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.update.return_value = t
        t.execute.return_value = _resp(None)
        return t

    real_db = MagicMock()
    real_db.table.side_effect = table

    http_mock = AsyncMock()
    http_mock.__aenter__ = AsyncMock(return_value=http_mock)
    http_mock.__aexit__ = AsyncMock(return_value=False)

    async def capture_post(url, json=None, headers=None):
        captured_payload.update(json or {})
        return MagicMock(status_code=200)

    http_mock.post = capture_post

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value=None), \
         patch("app.services.actor_executor.get_settings") as mock_settings, \
         patch("app.services.actor_executor.httpx.AsyncClient", return_value=http_mock):

        mock_settings.return_value.backend_url = "https://custom.example.com/api"

        from app.services.actor_executor import _dispatch_external_agent
        await _dispatch_external_agent(TASK, ACTOR_WEBHOOK, PROJECT, real_db)

    assert captured_payload["callback_url"] == "https://custom.example.com/api/agents/callback"
