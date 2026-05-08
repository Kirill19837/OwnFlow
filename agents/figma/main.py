"""
OwnFlow — Figma Design Agent
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import socket
import sys
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx

PAYLOAD_RAW = os.environ.get("PAYLOAD", "")
if not PAYLOAD_RAW:
    print("[figma-agent] ERROR: PAYLOAD env var not set", flush=True)
    sys.exit(1)

print(f"[figma-agent] DEBUG startup: PAYLOAD length={len(PAYLOAD_RAW)}", flush=True)
try:
    payload: dict = json.loads(PAYLOAD_RAW)
except json.JSONDecodeError as _e:
    print(f"[figma-agent] ERROR: PAYLOAD is not valid JSON: {_e}", flush=True)
    sys.exit(1)


OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
FIGMA_TOKEN = os.environ.get("FIGMA_TOKEN", "").strip()
FIGMA_FILE_KEY = os.environ.get("FIGMA_FILE_KEY", "").strip()
HTTP_PROXY = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or ""
HTTPS_PROXY = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or ""

print(
    f"[figma-agent] DEBUG startup: "
    f"OPENAI_API_KEY present={bool(OPENAI_API_KEY)} "
    f"ANTHROPIC_API_KEY present={bool(ANTHROPIC_API_KEY)} "
    f"FIGMA_TOKEN present={bool(FIGMA_TOKEN)} "
    f"FIGMA_FILE_KEY present={bool(FIGMA_FILE_KEY)} value={FIGMA_FILE_KEY!r} "
    f"HTTP_PROXY={bool(HTTP_PROXY)} HTTPS_PROXY={bool(HTTPS_PROXY)}",
    flush=True,
)

try:
    socket.getaddrinfo("api.figma.com", 443)
    print("[figma-agent] DEBUG network: api.figma.com resolvable ✓", flush=True)
except Exception as _dns_err:
    print(f"[figma-agent] ERROR network: api.figma.com NOT resolvable: {_dns_err}", flush=True)

# Try to detect outgoing IP for diagnostics
async def _detect_outgoing_ip() -> str:
    """Detect the outgoing IP that will be seen by Figma."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # Use a public IP detection service
            resp = await client.get("https://api.ipify.org?format=json")
            if resp.status_code == 200:
                return resp.json().get("ip", "unknown")
    except Exception:
        pass
    return "unknown"

MODEL: str = payload.get("model", "gpt-4o")
ACTOR: dict = payload.get("actor") or {}
ACTOR_ROLE: str = ACTOR.get("role") or "UI/UX Designer"
ACTOR_CAPABILITIES: list = ACTOR.get("capabilities") or []

def _get_figma_headers() -> dict:
    """Create fresh Figma headers for each request."""
    return {
        "X-Figma-Token": FIGMA_TOKEN,
        "Content-Type": "application/json"
    }

SYSTEM_PROMPT = f"""\
You are acting as: **{ACTOR_ROLE}**
You specialise in UI/UX design, design systems, component specifications, and design-to-code translation.
You will be given a task with its description and project context.
Produce a high-quality design deliverable appropriate to the task.

If design context from Figma is provided, reference it to ensure consistency with existing designs.

## Output types by task
- UI component spec → detailed spec with layout, spacing, colours, states, accessibility notes
- Design-to-code → production-ready CSS/Tailwind + React/HTML component
- Design system → tokens, component library spec, usage guidelines
- UX research / audit → structured findings with recommendations
- Wireframe description → detailed layout spec (text-based wireframe)

## CRITICAL: File output format — REQUIRED for every task
Your response MUST END with a ###FILES### section. This is NOT optional.

Format:
###FILES###
[
  {{"path": "docs/design/your-file-name.md", "content": "...file content..."}},
  {{"path": "src/components/Component.tsx", "content": "...file content..."}}
]

Rules:
- The ###FILES### block MUST be a raw JSON array — do NOT wrap it in markdown code fences (no ```json).
- Every file's content must be a complete string (no truncation)
- Path conventions:
  * React components          → src/components/<ComponentName>.tsx
  * CSS / Tailwind styles     → src/styles/<name>.css
  * Design specs / docs       → docs/design/<kebab-case-title>.md
  * Design tokens             → src/design-tokens.ts (or .json)
  * UX research               → docs/research/<kebab-case-title>.md

CRITICAL REMINDERS:
1. Write your full design/content FIRST in the response
2. Then add the ###FILES### block LAST (as the very final thing)
3. Output the JSON array DIRECTLY after ###FILES### — no backticks, no ```json wrapper
4. The JSON must be valid and parseable (close all brackets)
5. If the task involves a single deliverable, create at least one file
6. Never end your response without the ###FILES### section

Example of correct format:
---
# Design Spec

[Your full spec content here]

###FILES###
[{{"path": "docs/design/my-spec.md", "content": "# Design Spec\\n\\n[full content]"}}]
---
"""

FILES_REMINDER = """

---
FINAL INSTRUCTION: You MUST append a ###FILES### block at the END of your response.
Format exactly as shown — NO markdown code fences around the JSON:

###FILES###
[{"path": "docs/design/...", "content": "..."}]

IMPORTANT: Do NOT write ```json before the array. The [ must appear directly after ###FILES###.
Must be valid JSON. Must be the very last thing in your response.
"""


# ── HTTP client ───────────────────────────────────────────────────────────────

def _get_httpx_kwargs() -> dict:
    proxies = {}
    kwargs = {}
    if HTTPS_PROXY:
        proxies["https://"] = HTTPS_PROXY
    if HTTP_PROXY:
        proxies["http://"] = HTTP_PROXY
    if proxies:
        kwargs["proxies"] = proxies
        print(f"[figma-agent] DEBUG http: proxy configured https={bool(HTTPS_PROXY)} http={bool(HTTP_PROXY)}", flush=True)
    return kwargs


async def _figma_request_with_retry(method: str, url: str, max_retries: int = 3, headers: dict | None = None, **kwargs) -> httpx.Response:
    """Make a Figma API request with retry logic."""
    if headers is None:
        headers = _get_figma_headers()
    else:
        # Merge provided headers with Figma auth headers
        merged = _get_figma_headers()
        merged.update(headers)
        headers = merged

    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient(timeout=20.0, **_get_httpx_kwargs()) as client:
                if method.upper() == "GET":
                    resp = await client.get(url, headers=headers, **kwargs)
                elif method.upper() == "POST":
                    resp = await client.post(url, headers=headers, **kwargs)
                else:
                    resp = await client.request(method, url, headers=headers, **kwargs)

                if resp.status_code in (403, 429) or resp.status_code >= 500:
                    if attempt < max_retries - 1:
                        wait_time = 2 ** attempt
                        print(
                            f"[figma-agent] WARNING figma: HTTP {resp.status_code} — "
                            f"retry {attempt + 1}/{max_retries} after {wait_time}s",
                            flush=True,
                        )
                        await asyncio.sleep(wait_time)
                        continue
                return resp

        except (httpx.TimeoutException, httpx.ConnectError) as exc:
            if attempt < max_retries - 1:
                wait_time = 2 ** attempt
                print(
                    f"[figma-agent] WARNING figma: {type(exc).__name__} — "
                    f"retry {attempt + 1}/{max_retries} after {wait_time}s",
                    flush=True,
                )
                await asyncio.sleep(wait_time)
                continue
            raise

    async with httpx.AsyncClient(timeout=20.0, **_get_httpx_kwargs()) as client:
        if method.upper() == "GET":
            return await client.get(url, headers=headers, **kwargs)
        elif method.upper() == "POST":
            return await client.post(url, headers=headers, **kwargs)
        else:
            return await client.request(method, url, headers=headers, **kwargs)


# ── Figma API ─────────────────────────────────────────────────────────────────

async def create_figma_test_file(task_id: str) -> tuple[bool, str]:
    if not FIGMA_TOKEN:
        return False, "FIGMA_TOKEN not configured"

    print(f"[figma-agent] DEBUG figma: verifying token via /v1/me", flush=True)
    try:
        resp = await _figma_request_with_retry(
            "GET",
            "https://api.figma.com/v1/me",
            max_retries=3,
        )
        print(
            f"[figma-agent] DEBUG figma /v1/me: status={resp.status_code} "
            f"body={resp.text[:500]!r}",
            flush=True,
        )
        resp.raise_for_status()
        user_data = resp.json()
        user_id = user_data.get("id")
        user_name = user_data.get("handle", "Unknown")
        email = user_data.get("email", "")
        print(
            f"[figma-agent] DEBUG figma: authenticated as user={user_name!r} "
            f"id={user_id!r} email={email!r}",
            flush=True,
        )
        return True, f"Figma connection verified for user: {user_name} (id={user_id})"

    except httpx.HTTPStatusError as exc:
        body = exc.response.text[:800]
        status = exc.response.status_code
        headers = dict(exc.response.headers)

        # Diagnose CloudFront blocks
        is_cloudfront_block = (
            status == 403 and
            ("<!DOCTYPE" in body or "ERROR:" in body or "Request blocked" in body)
        )

        if is_cloudfront_block:
            print(
                f"[figma-agent] ERROR figma: CloudFront CDN block detected\n"
                f"  Status: {status}\n"
                f"  Response headers: {headers}\n"
                f"  Error message: {body[:300]}",
                flush=True
            )
            return False, (
                f"Figma blocked by CloudFront CDN (HTTP {status}). "
                f"Your server IP may be in Figma's IP blocklist. "
                f"Contact Figma support or use a VPN. "
                f"Details: {body[:200]}"
            )

        print(f"[figma-agent] ERROR figma: /v1/me HTTP {status}: {body}", flush=True)
        return False, f"Figma HTTP {status}: {body}"

    except Exception as exc:
        print(f"[figma-agent] ERROR figma: /v1/me request failed: {exc}", flush=True)
        return False, f"Figma connection failed: {exc}"


# ── Figma write ───────────────────────────────────────────────────────────────

async def create_figma_frame_with_content(
        file_key: str, page_name: str, frame_name: str, description: str
) -> tuple[bool, str]:
    if not FIGMA_TOKEN or not file_key:
        return False, "FIGMA_TOKEN or file_key not set"

    print(f"[figma-agent] DEBUG figma: adding comment to file={file_key!r}", flush=True)
    try:
        async with httpx.AsyncClient(timeout=30.0, **_get_httpx_kwargs()) as client:
            comment_resp = await client.post(
                f"https://api.figma.com/v1/files/{file_key}/comments",
                headers=_get_figma_headers(),
                json={
                    "message": f"🤖 AI Design Spec: {frame_name}\n\n{description[:2000]}",
                    "client_meta": {"x": 0, "y": 0},
                },
            )
            print(
                f"[figma-agent] DEBUG figma comment POST: "
                f"status={comment_resp.status_code} body={comment_resp.text[:400]!r}",
                flush=True,
            )
            comment_resp.raise_for_status()
            comment_id = comment_resp.json().get("id", "?")
            file_url = f"https://www.figma.com/file/{file_key}"
            print(f"[figma-agent] DEBUG figma: comment created id={comment_id!r}", flush=True)
            return True, f"Added design spec comment to Figma file: {file_url}"

    except httpx.HTTPStatusError as exc:
        body = exc.response.text[:400]
        print(f"[figma-agent] ERROR figma: comment POST HTTP {exc.response.status_code}: {body}", flush=True)
        return False, f"Figma comment failed (HTTP {exc.response.status_code}): {body}"

    except Exception as exc:
        print(f"[figma-agent] ERROR figma: comment POST exception: {exc}", flush=True)
        return False, f"Figma comment failed: {exc}"


# ── Figma context ─────────────────────────────────────────────────────────────

async def fetch_figma_context(file_key: str) -> str:
    if not FIGMA_TOKEN or not file_key:
        return ""
    print(f"[figma-agent] DEBUG figma: fetching file key={file_key!r}", flush=True)
    try:
        resp = await _figma_request_with_retry(
            "GET",
            f"https://api.figma.com/v1/files/{file_key}",
            max_retries=2,
        )
        print(f"[figma-agent] DEBUG figma file fetch: status={resp.status_code}", flush=True)
        resp.raise_for_status()
        data = resp.json()
        doc = data.get("document", {})
        name = data.get("name", file_key)
        pages = [c.get("name") for c in doc.get("children", []) if c.get("name")]
        print(f"[figma-agent] DEBUG figma: file={name!r} pages={pages}", flush=True)
        return (
            f"\n\n## Figma Design Context\n"
            f"File: {name}\n"
            f"Pages: {', '.join(pages) if pages else 'unknown'}\n"
            f"(Use this context to ensure design consistency with existing work.)\n"
        )
    except httpx.HTTPStatusError as exc:
        print(
            f"[figma-agent] WARNING figma: context fetch HTTP {exc.response.status_code}: "
            f"{exc.response.text[:300]}",
            flush=True,
        )
        return ""
    except Exception as exc:
        print(f"[figma-agent] WARNING figma: context fetch failed: {exc}", flush=True)
        return ""


# ── AI providers ──────────────────────────────────────────────────────────────

async def call_ai(prompt: str) -> str:
    if MODEL.startswith("claude"):
        return await _call_anthropic(prompt)
    return await _call_openai(prompt)


async def _call_openai(prompt: str) -> str:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set")
    async with httpx.AsyncClient(timeout=120.0, **_get_httpx_kwargs()) as client:
        resp = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": 8192,
            },
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


async def _call_anthropic(prompt: str) -> str:
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    async with httpx.AsyncClient(timeout=120.0, **_get_httpx_kwargs()) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
            },
            json={
                "model": MODEL,
                "max_tokens": 8192,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        resp.raise_for_status()
        return resp.json()["content"][0]["text"]


# ── File parsing ──────────────────────────────────────────────────────────────

def _try_parse_json_array(text: str) -> list[dict] | None:
    stripped = text.strip()
    if not stripped.startswith("["):
        return None
    try:
        result, _ = json.JSONDecoder().raw_decode(stripped)
        if isinstance(result, list):
            return result
    except json.JSONDecodeError:
        pass
    return None


def parse_files_with_fallback(text: str, task_title: str, log_fn) -> list[dict]:
    # Strategy 1: look for ###FILES### marker
    files_start = text.find("###FILES###")
    if files_start != -1:
        marker_end = files_start + len("###FILES###")
        remainder = text[marker_end:].strip()
        remainder = re.sub(r"^```(?:json)?\s*", "", remainder).strip()

        parsed = _try_parse_json_array(remainder)
        if parsed is not None:
            log_fn(f"[###FILES###] Parsed {len(parsed)} file(s): {[f.get('path') for f in parsed]}")
            return parsed
        else:
            log_fn(f"###FILES### found but JSON failed to parse — remainder: {remainder[:200]!r}", level="WARNING")

    # Strategy 2: JSON array inside a markdown code block
    code_block_pattern = re.compile(
        r"```(?:json)?\s*(\[\s*\{.*?\}\s*\])\s*```",
        re.DOTALL,
    )
    for match in code_block_pattern.finditer(text):
        candidate = match.group(1).strip()
        parsed = _try_parse_json_array(candidate)
        if parsed and all("path" in f and "content" in f for f in parsed):
            log_fn(
                f"[code-block fallback] Found JSON array inside markdown block — "
                f"parsed {len(parsed)} file(s): {[f.get('path') for f in parsed]}",
                level="WARNING",
            )
            return parsed

    # Strategy 3: JSON array at the end of the response (no marker, no code block)
    last_bracket = text.rfind("[{")
    if last_bracket != -1:
        candidate = text[last_bracket:].strip()
        close = candidate.rfind("]")
        if close != -1:
            candidate = candidate[:close + 1]
        parsed = _try_parse_json_array(candidate)
        if parsed and all("path" in f and "content" in f for f in parsed):
            log_fn(
                f"[tail-scan fallback] Found JSON array at response tail — "
                f"parsed {len(parsed)} file(s): {[f.get('path') for f in parsed]}",
                level="WARNING",
            )
            return parsed

    # Strategy 4: save entire response as a markdown file
    tail = text[-400:].replace("\n", "↵")
    log_fn(f"###FILES### missing — response tail: {tail!r}", level="WARNING")

    slug = re.sub(r"[^a-z0-9]+", "-", task_title.lower()).strip("-")
    fallback_path = f"docs/design/{slug}.md"
    log_fn(f"Saving full response as fallback file: {fallback_path}", level="WARNING")
    return [{"path": fallback_path, "content": text}]


# ── GitHub PR ─────────────────────────────────────────────────────────────────

async def create_pr(token: str, repo: str, task_id: str, task_title: str,
                    files: list[dict]) -> Optional[str]:
    branch = f"ownflow/design-{task_id[:8]}-{uuid.uuid4().hex[:6]}"
    api = f"https://api.github.com/repos/{repo}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    async with httpx.AsyncClient(timeout=30.0, **_get_httpx_kwargs()) as client:
        repo_resp = await client.get(api, headers=headers)
        repo_resp.raise_for_status()
        default_branch = repo_resp.json()["default_branch"]

        ref_resp = await client.get(f"{api}/git/ref/heads/{default_branch}", headers=headers)
        ref_resp.raise_for_status()
        base_sha = ref_resp.json()["object"]["sha"]

        commit_resp_base = await client.get(f"{api}/git/commits/{base_sha}", headers=headers)
        commit_resp_base.raise_for_status()
        base_tree_sha = commit_resp_base.json()["tree"]["sha"]

        create_ref_resp = await client.post(
            f"{api}/git/refs", headers=headers,
            json={"ref": f"refs/heads/{branch}", "sha": base_sha},
        )
        if create_ref_resp.status_code not in (200, 201, 422):
            create_ref_resp.raise_for_status()

        tree_items = []
        for f in files:
            blob = await client.post(
                f"{api}/git/blobs", headers=headers,
                json={"content": base64.b64encode(f["content"].encode()).decode(), "encoding": "base64"},
            )
            blob.raise_for_status()
            tree_items.append({
                "path": f["path"], "mode": "100644", "type": "blob", "sha": blob.json()["sha"]
            })

        tree_resp = await client.post(
            f"{api}/git/trees", headers=headers,
            json={"base_tree": base_tree_sha, "tree": tree_items},
        )
        tree_resp.raise_for_status()
        tree_sha = tree_resp.json()["sha"]

        commit_resp = await client.post(
            f"{api}/git/commits", headers=headers,
            json={"message": f"design: {task_title}", "tree": tree_sha, "parents": [base_sha]},
        )
        commit_resp.raise_for_status()
        commit_sha = commit_resp.json()["sha"]

        await client.patch(
            f"{api}/git/refs/heads/{branch}", headers=headers, json={"sha": commit_sha}
        )

        pr_resp = await client.post(
            f"{api}/pulls", headers=headers,
            json={
                "title": f"design: {task_title}",
                "head": branch,
                "base": default_branch,
                "body": f"Generated by OwnFlow Figma design agent\nTask: {task_id}",
            },
        )
        pr_resp.raise_for_status()
        return pr_resp.json()["html_url"]


# ── Main ──────────────────────────────────────────────────────────────────────

# ── Callback delivery (with retries) ──────────────────────────────────────────

_CALLBACK_MAX_ATTEMPTS = 5          # скільки спроб
_CALLBACK_BACKOFF_BASE  = 2         # секунд: 2, 4, 8, 16 …


async def _deliver_callback(
        url: str,
        token: str,
        body: dict,
        log_fn,
) -> None:

    last_exc: BaseException | None = None

    for attempt in range(1, _CALLBACK_MAX_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=30.0, **_get_httpx_kwargs()) as client:
                resp = await client.post(
                    url,
                    json=body,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                )

            if resp.status_code < 400:
                log_fn(
                    f"Callback delivered (attempt {attempt}/{_CALLBACK_MAX_ATTEMPTS})",
                    level="DEBUG",
                )
                return

            if resp.status_code < 500:
                raise RuntimeError(
                    f"Callback rejected with HTTP {resp.status_code}: {resp.text[:400]}"
                )

            last_exc = RuntimeError(
                f"Callback HTTP {resp.status_code}: {resp.text[:400]}"
            )

        except RuntimeError:
            raise
        except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPStatusError) as exc:
            last_exc = exc

        wait = _CALLBACK_BACKOFF_BASE ** (attempt - 1)   # 1, 2, 4, 8, 16 с
        log_fn(
            f"Callback attempt {attempt}/{_CALLBACK_MAX_ATTEMPTS} failed "
            f"({last_exc}) — retry in {wait}s",
            level="WARNING",
        )
        if attempt < _CALLBACK_MAX_ATTEMPTS:
            await asyncio.sleep(wait)

    raise RuntimeError(
        f"Callback delivery failed after {_CALLBACK_MAX_ATTEMPTS} attempts: {last_exc}"
    )


async def main() -> None:
    task_info = payload["task"]
    project_info = payload["project"]
    github_info = payload.get("github") or {}
    figma_info = payload.get("figma") or {}
    callback_url: str = payload["callback_url"]
    callback_token: str = payload["callback_token"]
    task_id: str = payload["task_id"]

    logs: list[dict] = []
    _LEVELS = {"DEBUG": 0, "INFO": 1, "WARNING": 2, "ERROR": 3}
    _PHASES = {
        "planning": 0, "agent_execution": 1,
        "external_dispatch": 2, "docker_dispatch": 3, "task_execution": 4,
    }

    def log(msg: str, level: str = "INFO", phase: str = "agent_execution") -> None:
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        print(f"[{ts}] [{level}] {msg}", flush=True)
        logs.append({
            "level": _LEVELS.get(level.upper(), 1),
            "phase": _PHASES.get(phase, 1),
            "message": msg,
        })

    log(f"task={task_id!r} role={ACTOR_ROLE!r} model={MODEL}")
    log(f"FIGMA_TOKEN present={bool(FIGMA_TOKEN)} len={len(FIGMA_TOKEN)}", level="DEBUG", phase="planning")

    # ── Diagnose network conditions ────────────────────────────────────────────
    outgoing_ip = await _detect_outgoing_ip()
    log(f"Outgoing IP (seen by Figma): {outgoing_ip}", level="DEBUG", phase="planning")

    # ── Figma connection test ──────────────────────────────────────────────────
    figma_test_success = False
    figma_blocked_by_network = False

    if FIGMA_TOKEN:
        log("Testing Figma API connection...", phase="planning")
        figma_test_success, figma_test_message = await create_figma_test_file(task_id)
        if figma_test_success:
            log(f"✓ Figma connection verified: {figma_test_message}", phase="planning")
        else:
            if "CloudFront" in figma_test_message or "Request blocked" in figma_test_message:
                figma_blocked_by_network = True
                log(
                    f"✗ Figma blocked by CDN (server IP {outgoing_ip} is likely in Figma's blocklist). "
                    f"Design spec will be saved locally.\n"
                    f"  To resolve: Contact Figma support with this IP: {outgoing_ip}\n"
                    f"  Or: Use a VPN/proxy to change your IP\n"
                    f"  Details: {figma_test_message}",
                    level="WARNING", phase="planning",
                )
            else:
                log(f"✗ Figma connection failed: {figma_test_message}", level="ERROR", phase="planning")
            log("Continuing task execution despite Figma auth failure", level="WARNING", phase="planning")
    else:
        log("FIGMA_TOKEN not set — skipping Figma operations", level="WARNING", phase="planning")

    # ── Resolve Figma file key ─────────────────────────────────────────────────
    figma_file_key = FIGMA_FILE_KEY or figma_info.get("file_key") or ""
    log(
        f"figma_file_key resolved={figma_file_key!r} "
        f"(from env={bool(FIGMA_FILE_KEY)} / payload={bool(figma_info.get('file_key'))})",
        level="DEBUG", phase="planning",
    )

    figma_context = ""
    if FIGMA_TOKEN and figma_file_key and figma_test_success:
        figma_context = await fetch_figma_context(figma_file_key)
        if figma_context:
            log(f"Fetched Figma context for file key={figma_file_key!r}", phase="planning")

    # ── Build prompt ───────────────────────────────────────────────────────────
    prompt = (
        f"Project: {project_info['name']}\n"
        f"Project brief: {project_info.get('brief', '')}\n"
        f"{figma_context}\n"
        f"Task title: {task_info['title']}\n"
        f"Task description: {task_info.get('description', '')}\n"
        f"Task type: {task_info.get('type', 'design')}  |  "
        f"Priority: {task_info.get('priority', 'medium')}\n"
    )
    if ACTOR_ROLE:
        prompt += f"\nYour assigned role for this task: {ACTOR_ROLE}\n"

    prompt += FILES_REMINDER

    log(f"prompt_length={len(prompt)} chars", level="DEBUG", phase="planning")

    # ── AI call ────────────────────────────────────────────────────────────────
    log(f"Calling AI provider (model={MODEL})...")
    t0 = datetime.now(timezone.utc)
    try:
        content = await call_ai(prompt)
    except Exception as exc:
        log(f"AI provider call failed: {type(exc).__name__}: {exc}", level="ERROR")
        raise
    elapsed = (datetime.now(timezone.utc) - t0).total_seconds()
    log(f"AI responded in {elapsed:.1f}s — {len(content)} chars")

    tail_preview = content[-400:].replace("\n", "↵") if len(content) > 400 else content.replace("\n", "↵")
    log(f"AI response tail (last 400 chars): {tail_preview!r}", level="DEBUG")

    # ── Parse files ────────────────────────────────────────────────────────────
    files = parse_files_with_fallback(content, task_info["title"], log)
    log(f"Parsed {len(files)} file(s) from response")

    # ── Write to Figma ─────────────────────────────────────────────────────────
    figma_write_result = ""
    if figma_file_key and FIGMA_TOKEN:
        if figma_test_success:
            log(f"Attempting to write design to Figma file={figma_file_key!r}")
            figma_success, figma_msg = await create_figma_frame_with_content(
                figma_file_key, "Designs", task_info["title"], content,
            )
            if figma_success:
                log(f"✓ Figma write: {figma_msg}")
                figma_write_result = f"\n**Figma:** {figma_msg}"
            else:
                log(f"✗ Figma write failed: {figma_msg}", level="ERROR")
        elif figma_blocked_by_network:
            log(
                "Skipping Figma write — server blocked by Figma CloudFront CDN. "
                "Design saved to output files.",
                level="WARNING",
            )
        else:
            log(
                "Skipping Figma write — auth failed earlier (FIGMA_TOKEN present)",
                level="WARNING",
            )
    elif figma_file_key and not FIGMA_TOKEN:
        log("figma_file_key provided but FIGMA_TOKEN missing — skipping Figma write", level="WARNING")

    # ── GitHub PR ──────────────────────────────────────────────────────────────
    pr_url: Optional[str] = None
    gh_repo = github_info.get("repo")
    gh_token = github_info.get("token")
    if files and gh_repo and gh_token:
        log(f"Creating PR on repo={gh_repo!r} for {len(files)} file(s)")
        try:
            pr_url = await create_pr(gh_token, gh_repo, task_id, task_info["title"], files)
            log(f"PR created: {pr_url}")
        except Exception as exc:
            log(f"PR creation failed: {type(exc).__name__}: {exc}", level="ERROR")
    elif files:
        log("Files parsed but no GitHub connection — skipping PR")
    else:
        log("No files — skipping PR")

    if pr_url:
        content += f"\n\n**GitHub PR:** {pr_url}"
    if figma_write_result:
        content += figma_write_result

    # ── Callback ───────────────────────────────────────────────────────────────
    callback_body = {
        "task_id": task_id,
        "content": content,
        "files": files if (files and not pr_url) else None,
        "logs": logs,
        "prompt": prompt,
        "model": MODEL,
    }

    log(f"Sending callback to {callback_url}")
    try:
        await _deliver_callback(callback_url, callback_token, callback_body, log)
        log("Callback delivered successfully")
    except RuntimeError as exc:
        log(f"Callback delivery permanently failed: {exc}", level="ERROR")
        raise SystemExit(1) from exc


if __name__ == "__main__":
    asyncio.run(main())
