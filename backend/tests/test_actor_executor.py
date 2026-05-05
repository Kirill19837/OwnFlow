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

    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_docker_client = MagicMock()
    mock_docker_client.containers.run.return_value = mock_container

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value=None), \
         patch("app.services.actor_executor.get_settings") as mock_settings, \
         patch("app.services.actor_executor.docker.from_env", return_value=mock_docker_client):

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
    assert result["container_id"] == "abc123"


@pytest.mark.asyncio
async def test_dispatch_docker_payload_contains_required_fields():
    """Verify the PAYLOAD env dict passed to docker contains all contract fields."""
    captured_env: dict = {}

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

    mock_container = MagicMock()
    mock_container.id = "cid123"
    mock_docker_client = MagicMock()

    def fake_run(image, **kwargs):
        captured_env.update(kwargs.get("environment", {}))
        return mock_container

    mock_docker_client.containers.run.side_effect = fake_run

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value={"owner": "acme", "repo": "app", "token": "ghp_test"}), \
         patch("app.services.actor_executor.get_settings") as mock_settings, \
         patch("app.services.actor_executor.docker.from_env", return_value=mock_docker_client):

        mock_settings.return_value.backend_url = "https://ownflow.example.com/api"
        mock_settings.return_value.builtin_agent_image = "ownflow-agent:latest"
        mock_settings.return_value.openai_api_key = "sk-openai"
        mock_settings.return_value.anthropic_api_key = ""

        from app.services.actor_executor import _dispatch_docker_agent
        await _dispatch_docker_agent(TASK, ACTOR_DOCKER, PROJECT, real_db)

    assert "PAYLOAD" in captured_env, "PAYLOAD key not found in container environment"
    payload = json.loads(captured_env["PAYLOAD"])

    assert payload["task_id"] == TASK_ID
    assert "callback_url" in payload
    assert "callback_token" in payload
    assert payload["task"]["title"] == TASK["title"]
    assert payload["project"]["name"] == PROJECT["name"]
    assert payload["github"]["repo"] == "acme/app"
    assert payload["model"] == ACTOR_DOCKER["model"]


@pytest.mark.asyncio
async def test_dispatch_docker_logs_error_on_api_error():
    """docker.errors.APIError is caught, logged, and returns dispatched=False."""
    import docker as _docker

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

    mock_docker_client = MagicMock()
    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.reason = "Internal Server Error"
    mock_docker_client.containers.run.side_effect = _docker.errors.APIError(
        "server error", response=mock_response
    )

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value=None), \
         patch("app.services.actor_executor.get_settings") as mock_settings, \
         patch("app.services.actor_executor.docker.from_env", return_value=mock_docker_client):

        mock_settings.return_value.backend_url = ""
        mock_settings.return_value.builtin_agent_image = "ownflow-agent:latest"
        mock_settings.return_value.openai_api_key = ""
        mock_settings.return_value.anthropic_api_key = ""

        from app.services.actor_executor import _dispatch_docker_agent
        result = await _dispatch_docker_agent(TASK, ACTOR_DOCKER, PROJECT, real_db)

    assert result["dispatched"] is False
    assert result["task_id"] == TASK_ID
    assert logged.get("level") == 3


# ---------------------------------------------------------------------------
# _resolve_builtin_image  +  ROLE_IMAGE_MAP
# ---------------------------------------------------------------------------

from app.services.actor_executor import ROLE_IMAGE_MAP, _resolve_builtin_image

DEFAULT_IMAGE   = ROLE_IMAGE_MAP["default"]
FIGMA_IMAGE     = ROLE_IMAGE_MAP["ui/ux designer"]
DOCS_IMAGE      = ROLE_IMAGE_MAP["business analyst"]
SERVER_FALLBACK = "ownflow-agent:test"


class TestRoleImageMap:
    def test_default_key_exists(self):
        assert "default" in ROLE_IMAGE_MAP

    def test_ui_ux_designer_maps_to_figma(self):
        assert ROLE_IMAGE_MAP["ui/ux designer"] == "ownflow-figma-agent:latest"

    def test_business_analyst_maps_to_docs(self):
        assert ROLE_IMAGE_MAP["business analyst"] == "ownflow-docs-agent:latest"

    def test_default_maps_to_general_agent(self):
        assert ROLE_IMAGE_MAP["default"] == "ownflow-agent:latest"


class TestResolveBuiltinImage:
    # explicit docker_image on actor wins everything
    def test_explicit_docker_image_wins(self):
        actor = {"role": "ui/ux designer", "docker_image": "custom-image:v2"}
        assert _resolve_builtin_image(actor, SERVER_FALLBACK) == "custom-image:v2"

    def test_explicit_docker_image_wins_over_default_role(self):
        actor = {"role": "business analyst", "docker_image": "special:latest"}
        assert _resolve_builtin_image(actor, SERVER_FALLBACK) == "special:latest"

    # role-based lookup
    def test_ui_ux_designer_role_resolves_to_figma(self):
        actor = {"role": "UI/UX Designer", "docker_image": None}
        assert _resolve_builtin_image(actor, SERVER_FALLBACK) == FIGMA_IMAGE

    def test_business_analyst_role_resolves_to_docs(self):
        actor = {"role": "Business Analyst", "docker_image": None}
        assert _resolve_builtin_image(actor, SERVER_FALLBACK) == DOCS_IMAGE

    def test_role_lookup_is_case_insensitive(self):
        for role in ("UI/UX DESIGNER", "ui/ux designer", "Ui/Ux Designer"):
            actor = {"role": role, "docker_image": None}
            assert _resolve_builtin_image(actor, SERVER_FALLBACK) == FIGMA_IMAGE, role

    def test_role_with_surrounding_whitespace_normalised(self):
        actor = {"role": "  ui/ux designer  ", "docker_image": None}
        assert _resolve_builtin_image(actor, SERVER_FALLBACK) == FIGMA_IMAGE

    # unknown role falls back to ROLE_IMAGE_MAP["default"]
    def test_unknown_role_falls_back_to_map_default(self):
        actor = {"role": "Lead Engineer", "docker_image": None}
        assert _resolve_builtin_image(actor, SERVER_FALLBACK) == DEFAULT_IMAGE

    def test_empty_role_falls_back_to_map_default(self):
        actor = {"role": "", "docker_image": None}
        assert _resolve_builtin_image(actor, SERVER_FALLBACK) == DEFAULT_IMAGE

    def test_missing_role_key_falls_back_to_map_default(self):
        actor = {"docker_image": None}
        assert _resolve_builtin_image(actor, SERVER_FALLBACK) == DEFAULT_IMAGE

    def test_none_role_falls_back_to_map_default(self):
        actor = {"role": None, "docker_image": None}
        assert _resolve_builtin_image(actor, SERVER_FALLBACK) == DEFAULT_IMAGE

    # server setting used only when map["default"] is absent (edge-case safety)
    def test_server_fallback_used_when_default_key_removed(self, monkeypatch):
        import app.services.actor_executor as mod
        original = mod.ROLE_IMAGE_MAP.copy()
        monkeypatch.delitem(mod.ROLE_IMAGE_MAP, "default")
        actor = {"role": "Unknown", "docker_image": None}
        result = _resolve_builtin_image(actor, SERVER_FALLBACK)
        assert result == SERVER_FALLBACK
        mod.ROLE_IMAGE_MAP.clear()
        mod.ROLE_IMAGE_MAP.update(original)


# ---------------------------------------------------------------------------
# _dispatch_docker_agent — image resolution integration
# ---------------------------------------------------------------------------

def _docker_dispatch_db():
    """Minimal DB mock sufficient for _dispatch_docker_agent."""
    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.update.return_value = t
        t.insert.return_value = t
        t.execute.return_value = _resp({} if name == "companies" else None)
        return t
    db = MagicMock()
    db.table.side_effect = table
    return db


async def _run_dispatch(actor: dict) -> str:
    """Run _dispatch_docker_agent and return the image it passed to docker."""
    images_used: list[str] = []

    mock_container = MagicMock()
    mock_container.id = "cid"
    mock_client = MagicMock()

    def fake_run(image, **_kwargs):
        images_used.append(image)
        return mock_container

    mock_client.containers.run.side_effect = fake_run

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value=None), \
         patch("app.services.actor_executor.get_settings") as ms, \
         patch("app.services.actor_executor.docker.from_env", return_value=mock_client):

        ms.return_value.backend_url = ""
        ms.return_value.builtin_agent_image = "ownflow-agent:latest"
        ms.return_value.openai_api_key = "sk-x"
        ms.return_value.anthropic_api_key = ""

        from app.services.actor_executor import _dispatch_docker_agent
        await _dispatch_docker_agent(TASK, actor, PROJECT, _docker_dispatch_db())

    return images_used[0]


@pytest.mark.asyncio
async def test_dispatch_uses_figma_image_for_designer_role():
    actor = {**ACTOR_DOCKER, "role": "UI/UX Designer", "docker_image": None}
    assert await _run_dispatch(actor) == "ownflow-figma-agent:latest"


@pytest.mark.asyncio
async def test_dispatch_uses_docs_image_for_ba_role():
    actor = {**ACTOR_DOCKER, "role": "Business Analyst", "docker_image": None}
    assert await _run_dispatch(actor) == "ownflow-docs-agent:latest"


@pytest.mark.asyncio
async def test_dispatch_uses_default_image_for_unknown_role():
    actor = {**ACTOR_DOCKER, "role": "QA Engineer", "docker_image": None}
    assert await _run_dispatch(actor) == "ownflow-agent:latest"


@pytest.mark.asyncio
async def test_dispatch_uses_explicit_docker_image_override():
    actor = {**ACTOR_DOCKER, "role": "UI/UX Designer", "docker_image": "my-custom-agent:v3"}
    assert await _run_dispatch(actor) == "my-custom-agent:v3"


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
         patch("app.services.actor_executor._assert_safe_webhook_url", new_callable=AsyncMock), \
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
         patch("app.services.actor_executor._assert_safe_webhook_url", new_callable=AsyncMock), \
         patch("app.services.actor_executor.httpx.AsyncClient", return_value=http_mock):

        mock_settings.return_value.backend_url = ""

        from app.services.actor_executor import _dispatch_external_agent
        result = await _dispatch_external_agent(TASK, ACTOR_WEBHOOK, PROJECT, real_db)

    # Should not raise — logs the error and returns dispatched=False
    assert result["dispatched"] is False
    assert logged.get("level") == 3
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
         patch("app.services.actor_executor._assert_safe_webhook_url", new_callable=AsyncMock), \
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
         patch("app.services.actor_executor._assert_safe_webhook_url", new_callable=AsyncMock), \
         patch("app.services.actor_executor.httpx.AsyncClient", return_value=http_mock):

        mock_settings.return_value.backend_url = "https://custom.example.com/api"

        from app.services.actor_executor import _dispatch_external_agent
        await _dispatch_external_agent(TASK, ACTOR_WEBHOOK, PROJECT, real_db)

    assert captured_payload["callback_url"] == "https://custom.example.com/api/agents/callback"


# ---------------------------------------------------------------------------
# SSRF guard tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_assert_safe_webhook_url_accepts_public_https():
    import ipaddress, socket
    from app.services.actor_executor import _assert_safe_webhook_url

    public_ip = "93.184.216.34"  # example.com
    fake_infos = [(None, None, None, None, (public_ip, 0))]
    with patch("app.services.actor_executor.socket.getaddrinfo", return_value=fake_infos):
        # Should not raise
        await _assert_safe_webhook_url("https://agent.example.com/run")


@pytest.mark.asyncio
@pytest.mark.parametrize("private_ip", [
    "127.0.0.1",       # loopback
    "::1",             # IPv6 loopback
    "10.0.0.1",        # RFC-1918
    "172.16.0.1",      # RFC-1918
    "192.168.1.1",     # RFC-1918
    "169.254.0.1",     # link-local
    "0.0.0.0",         # unspecified
])
async def test_assert_safe_webhook_url_rejects_private_ips(private_ip):
    from app.services.actor_executor import _assert_safe_webhook_url

    fake_infos = [(None, None, None, None, (private_ip, 0))]
    with patch("app.services.actor_executor.socket.getaddrinfo", return_value=fake_infos):
        with pytest.raises(ValueError, match="non-routable"):
            await _assert_safe_webhook_url("https://internal.local/run")


@pytest.mark.asyncio
async def test_assert_safe_webhook_url_rejects_non_http_scheme():
    from app.services.actor_executor import _assert_safe_webhook_url

    with pytest.raises(ValueError, match="scheme must be http or https"):
        await _assert_safe_webhook_url("ftp://agent.example.com/run")


@pytest.mark.asyncio
async def test_assert_safe_webhook_url_rejects_unresolvable_host():
    import socket
    from app.services.actor_executor import _assert_safe_webhook_url

    with patch("app.services.actor_executor.socket.getaddrinfo",
               side_effect=socket.gaierror("Name or service not known")):
        with pytest.raises(ValueError, match="could not be resolved"):
            await _assert_safe_webhook_url("https://does-not-exist.invalid/run")


@pytest.mark.asyncio
async def test_dispatch_external_blocked_by_ssrf_guard():
    """SSRF guard: dispatch returns dispatched=False and logs error without making HTTP call."""
    logged = {}

    def table(name):
        t = MagicMock()
        t.select.return_value = t
        t.eq.return_value = t
        t.single.return_value = t
        t.update.return_value = t
        if name == "ai_logs":
            def capture(data):
                logged.update(data)
                m = MagicMock()
                m.execute.return_value = _resp(None)
                return m
            t.insert.side_effect = capture
        else:
            t.execute.return_value = _resp(None)
        return t

    real_db = MagicMock()
    real_db.table.side_effect = table

    ssrf_actor = {**ACTOR_WEBHOOK, "webhook_url": "https://internal.corp/run"}

    with patch("app.services.actor_executor.get_connection_for_project", new_callable=AsyncMock, return_value=None), \
         patch("app.services.actor_executor.get_settings") as mock_settings, \
         patch("app.services.actor_executor._assert_safe_webhook_url",
               new_callable=AsyncMock,
               side_effect=ValueError("resolves to a non-routable address (10.0.0.1)")):

        mock_settings.return_value.backend_url = ""
        from app.services.actor_executor import _dispatch_external_agent
        result = await _dispatch_external_agent(TASK, ssrf_actor, PROJECT, real_db)

    assert result["dispatched"] is False
    assert "error" in result
    assert logged.get("level") == 3
    assert "Blocked" in logged.get("message", "")
