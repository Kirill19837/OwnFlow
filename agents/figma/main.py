"""
OwnFlow — Figma Design Agent
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
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
HTTP_PROXY = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or ""
HTTPS_PROXY = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or ""

print(
    f"[figma-agent] DEBUG startup: "
    f"OPENAI_API_KEY present={bool(OPENAI_API_KEY)} "
    f"ANTHROPIC_API_KEY present={bool(ANTHROPIC_API_KEY)} "
    f"HTTP_PROXY={bool(HTTP_PROXY)} HTTPS_PROXY={bool(HTTPS_PROXY)}",
    flush=True,
)



def _get_httpx_kwargs() -> dict:
    """Build httpx client kwargs (proxy support)."""
    kwargs = {}
    if HTTP_PROXY:
        kwargs["http2"] = True
        kwargs["proxies"] = {"http://": HTTP_PROXY, "https://": HTTPS_PROXY or HTTP_PROXY}
    elif HTTPS_PROXY:
        kwargs["http2"] = True
        kwargs["proxies"] = {"https://": HTTPS_PROXY}
    return kwargs

MODEL: str = payload.get("model", "gpt-4o")
ACTOR: dict = payload.get("actor") or {}
ACTOR_ROLE: str = ACTOR.get("role") or "UI/UX Designer"
ACTOR_CAPABILITIES: list = ACTOR.get("capabilities") or []

SYSTEM_PROMPT = f"""\
YOUR RESPONSE MUST BE EXACTLY THIS FORMAT AND NOTHING ELSE:

```javascript
async function createDesign() {{
  // figma code here
}}
createDesign().catch(e => console.error(e));
```

ABSOLUTE REQUIREMENTS (this is a contract):
- Your ENTIRE response is ONLY what's between and including the ``` markers
- Line 1 must be: ```javascript
- Last line must be: ```
- ZERO characters before the first ```javascript
- ZERO characters after the final ```
- ZERO explanations, descriptions, comments outside the code block
- ZERO markdown formatting outside the code block
- ZERO newlines before the first ``` or after the last ```

FIGMA API RULES — follow every rule exactly:

FONTS:
- Load fonts BEFORE any figma.createText() call
- Load ONLY these two variants — no others exist reliably:
await figma.loadFontAsync({{ family: "Inter", style: "Regular" }});
await figma.loadFontAsync({{ family: "Inter", style: "Bold" }});
- Never use "SemiBold", "Medium", "Light", or any other style — they will silently fail
- Set font on text nodes using ONLY:
node.fontName = {{ family: "Inter", style: "Regular" }};
node.fontName = {{ family: "Inter", style: "Bold" }};
- NEVER use .fontFamily or .fontWeight — these properties do not exist in the Figma API

SIZING:
- NEVER set .width or .height directly
- ALWAYS use node.resize(width, height) — EXCEPT for Auto Layout frames,
  where resize() must be called BEFORE appendChild() or omitted entirely

ASYNC / LOOPS:
- NEVER use .forEach() with await inside — forEach ignores async/await silently
- ALWAYS use for...of when await is needed inside a loop:

    WRONG:
    items.forEach(async (item) => {{
        await figma.loadFontAsync(...); // silently ignored
    }});

    CORRECT:
    for (const item of items) {{
        await figma.loadFontAsync(...); // works correctly
    }}
    
CODE EFFICIENCY RULES (critical — output has a hard token limit):
- NEVER repeat figma.loadFontAsync() — load all fonts ONCE at the top of the function
- NEVER use verbose variable names — use short ones: f (frame), t (text), r (rect)
- Reuse helper functions for repeated patterns (e.g. makeButton, makeInput)
- Do NOT add comments explaining what the code does
- Do NOT add blank lines between statements
- If creating many similar items, use a loop with a data array, never copy-paste blocks
- Prioritize completeness over readability — the code must fully run, never be truncated

What the code MUST do:
- Create Figma design elements using the Figma Plugin SDK
- Use figma.createFrame(), figma.createText(), figma.createComponent(), etc.
- Set colors, typography, sizing, and constraints using the Figma API
- Treat "design system", "colors", "typography", "wireframes" as CODE that creates them

TEXT ALIGNMENT & PADDING RULES:
- For buttons: ALWAYS use Auto Layout so text centers automatically:
    node.layoutMode = "HORIZONTAL";
    node.primaryAxisAlignItems = "CENTER";
    node.counterAxisAlignItems = "CENTER";
    node.paddingLeft = 16; node.paddingRight = 16;
    node.paddingTop = 12; node.paddingBottom = 12;
- For input fields: use Auto Layout with left padding:
    node.layoutMode = "HORIZONTAL";
    node.counterAxisAlignItems = "CENTER";
    node.paddingLeft = 12; node.paddingRight = 12;
    node.paddingTop = 10; node.paddingBottom = 10;
- NEVER position text with x/y inside a button or input — use Auto Layout padding instead

FORMAT EXAMPLES:

CORRECT:
```javascript
async function createDesign() {{
    const page = figma.currentPage;
await figma.loadFontAsync({{ family: "Inter", style: "Regular" }});
const frame = figma.createFrame();
frame.resize(375, 812);
const text = figma.createText();
text.fontName = {{ family: "Inter", style: "Regular" }};
text.characters = "Hello";
frame.appendChild(text);
}}
createDesign().catch(e => console.error(e));
```

WRONG — never do these:
- Text before the code block: "Here's the code: ```javascript"
- Text after the code block: "``` Let me know if you need changes!"
- Any font style other than "Regular" or "Bold"
- .width = 100 instead of .resize(100, height)
- forEach with await inside

YOUR RESPONSE STARTS NOW. RESPOND WITH ONLY THE CODE BLOCK. NOTHING ELSE.
"""

FILES_REMINDER = ""

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
                "temperature": 0,
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
                "temperature": 0,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        resp.raise_for_status()
        return resp.json()["content"][0]["text"]


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


def _extract_js_block(text: str) -> str | None:
    # Strategy 1: Properly closed ```javascript ... ```
    js_pattern = re.compile(r"```javascript\s*(.*?)\s*```", re.DOTALL)
    js_match = js_pattern.search(text)
    if js_match:
        code = js_match.group(1).strip()
        if code and ("figma." in code or "async function" in code or "createDesign" in code):
            return code

    # Strategy 2: INCOMPLETE code block - look for ```javascript...EOF (no closing marker)
    # This handles truncated responses
    incomplete_pattern = re.compile(r"```javascript\s*(async function[\s\S]+?)(?:```|$)", re.DOTALL)
    incomplete_match = incomplete_pattern.search(text)
    if incomplete_match:
        code = incomplete_match.group(1).strip()
        if code and "figma." in code:
            # Keep as much code as possible - only remove truly broken lines
            lines = code.split("\n")
            # Only remove last line if it's a tiny fragment (< 10 chars)
            if lines[-1].strip() and len(lines[-1].strip()) < 10 and "." in lines[-1]:
                # Likely incomplete property, remove it
                if len(lines) > 1:
                    lines = lines[:-1]
            code = "\n".join(lines).strip()
            if len(code) > 100:  # Must be substantial code
                return code

    # Strategy 3: Generic code block
    generic_pattern = re.compile(r"```\s*((?:async\s+)?function\s+\w+[\s\S]*?)\s*```", re.DOTALL)
    generic_match = generic_pattern.search(text)
    if generic_match:
        code = generic_match.group(1).strip()
        if "figma." in code or "function create" in code.lower():
            return code

    # Strategy 4: Any code block with figma references
    code_pattern = re.compile(r"```(?:javascript|js)?\s*\n([\s\S]*?)\n```", re.DOTALL)
    for match in code_pattern.finditer(text):
        code = match.group(1).strip()
        if "figma." in code:
            return code

    # Strategy 5: Last resort - look for code without markers but with figma references
    figma_code_pattern = re.compile(r"(async\s+function\s+createDesign\s*\(\s*\)\s*\{[\s\S]*?figma\.[\s\S]{50,})", re.DOTALL)
    figma_match = figma_code_pattern.search(text)
    if figma_match:
        code = figma_match.group(1).strip()
        if len(code) > 100:
            return code

    return None


def parse_files_with_fallback(text: str, task_title: str, log_fn) -> list[dict]:
    slug = re.sub(r"[^a-z0-9]+", "-", task_title.lower()).strip("-") or "untitled"

    # Log response type for debugging
    starts_with_code = text.strip().startswith("```")
    has_js_marker = "```javascript" in text or "```js" in text
    has_figma_code = "figma." in text and "async function" in text
    response_len = len(text)
    log_fn(f"[parse-check] starts_with_code={starts_with_code} has_js={has_js_marker} has_figma={has_figma_code} response_len={response_len}", level="DEBUG")

    # Strategy 1: Extract JS code block FIRST (most reliable)
    js_code = _extract_js_block(text)
    if js_code:
        fallback_path = f"designs/{slug}.js"
        code_lines = js_code.count("\n") + 1
        log_fn(f"[js-extract PRIMARY] Found JS block ({len(js_code)} chars, {code_lines} lines), saving as: {fallback_path}", level="INFO")

        if "createDesign().catch" not in js_code and "createDesign()" not in js_code:
            js_code += "\n\ncreateDesign().catch(e => console.error(e));"
            log_fn("[fix] Appended missing createDesign() call", level="INFO")

        return [{"path": fallback_path, "content": js_code}]

    # If no code found but text starts with description, log this explicitly
    if text.strip() and not (starts_with_code and has_js_marker):
        log_fn(f"[WARNING] AI response does not match expected JavaScript format", level="WARNING")
        # Extract first 100 chars to see what went wrong
        first_part = text[:100].replace("\n", " ")
        log_fn(f"[WARNING] Response starts with: {first_part}...", level="DEBUG")

    # Strategy 2: ###FILES### marker
    files_start = text.find("###FILES###")
    if files_start != -1:
        marker_end = files_start + len("###FILES###")
        remainder = text[marker_end:].strip()
        remainder = re.sub(r"^```(?:json)?\s*", "", remainder).strip()
        parsed = _try_parse_json_array(remainder)
        if parsed is not None:
            log_fn(f"[###FILES###] Parsed {len(parsed)} file(s): {[f.get('path') for f in parsed]}", level="DEBUG")
            return parsed
        else:
            log_fn(f"[DEBUG] ###FILES### marker found but JSON parse failed", level="DEBUG")

    # Strategy 3: JSON array inside a markdown code block
    code_block_pattern = re.compile(r"```(?:json)?\s*(\[\s*\{.*?\}\s*\])\s*```", re.DOTALL)
    for match in code_block_pattern.finditer(text):
        candidate = match.group(1).strip()
        parsed = _try_parse_json_array(candidate)
        if parsed and all("path" in f and "content" in f for f in parsed):
            log_fn(f"[DEBUG] Parsed JSON from code block: {len(parsed)} file(s)", level="DEBUG")
            return parsed

    # Strategy 4: JSON array at end of response
    last_bracket = text.rfind("[{")
    if last_bracket != -1:
        candidate = text[last_bracket:].strip()
        close = candidate.rfind("]")
        if close != -1:
            candidate = candidate[:close + 1]
        parsed = _try_parse_json_array(candidate)
        if parsed and all("path" in f and "content" in f for f in parsed):
            log_fn(f"[DEBUG] Parsed JSON from tail: {len(parsed)} file(s)", level="DEBUG")
            return parsed

    # No valid output found — save raw response as both .md and .js so the code is never lost
    log_fn(f"[WARNING] Could not extract JavaScript code or file list from response — saving raw fallback", level="WARNING")

    md_path = f"designs/{slug}.md"
    js_path = f"designs/{slug}.js"

    # Markdown file: human-readable, shows the full raw AI response
    md_content = f"# Fallback: raw AI response\n\nTask: `{task_title}`\n\n---\n\n{text}"

    # JS file: wrap raw text in a comment block so it's valid enough to open in an editor
    js_content = f"// Fallback — could not parse structured code from AI response\n// Task: {task_title}\n\n/*\n{text}\n*/"

    log_fn(f"[fallback] Saving raw response as {md_path} and {js_path}", level="INFO")
    return [
        {"path": md_path, "content": md_content},
        {"path": js_path, "content": js_content},
    ]


async def create_pr(token: str, repo: str, task_id: str, task_title: str, files: list[dict]) -> Optional[str]:
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
            tree_items.append({"path": f["path"], "mode": "100644", "type": "blob", "sha": blob.json()["sha"]})

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

        await client.patch(f"{api}/git/refs/heads/{branch}", headers=headers, json={"sha": commit_sha})

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


_CALLBACK_MAX_ATTEMPTS = 5
_CALLBACK_BACKOFF_BASE  = 2


async def _deliver_callback(url: str, token: str, body: dict, log_fn) -> None:
    last_exc: BaseException | None = None

    for attempt in range(1, _CALLBACK_MAX_ATTEMPTS + 1):
        try:
            json_body = json.dumps(body)
            log_fn(f"[deliver-attempt {attempt}] Sending POST to {url} with {len(json_body)} bytes", level="DEBUG")
            log_fn(f"[deliver-auth] Token length={len(token)}, URL={url}", level="DEBUG")

            try:
                async with httpx.AsyncClient(timeout=30.0, **_get_httpx_kwargs()) as client:
                    log_fn(f"[deliver-client] HTTP client created, posting...", level="DEBUG")
                    resp = await client.post(
                        url,
                        json=body,
                        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                    )
                    log_fn(f"[deliver-post-returned] Got response object", level="DEBUG")
            except asyncio.TimeoutError as te:
                log_fn(f"[deliver-timeout] Request timed out after 30s: {te}", level="ERROR")
                raise RuntimeError(f"Callback POST timed out: {te}")
            except Exception as post_exc:
                log_fn(f"[deliver-post-error] Exception during POST: {type(post_exc).__name__}: {post_exc}", level="ERROR")
                raise

            log_fn(f"[deliver-response] HTTP {resp.status_code} received", level="DEBUG")
            if resp.status_code >= 400:
                resp_text = resp.text[:500]
                log_fn(f"[deliver-error] Response body: {resp_text}", level="DEBUG")

            if resp.status_code < 400:
                log_fn(f"Callback delivered (attempt {attempt}/{_CALLBACK_MAX_ATTEMPTS})", level="INFO")
                return

            if resp.status_code < 500:
                raise RuntimeError(f"Callback rejected with HTTP {resp.status_code}: {resp.text[:400]}")

            last_exc = RuntimeError(f"Callback HTTP {resp.status_code}: {resp.text[:400]}")

        except RuntimeError as run_exc:
            log_fn(f"[deliver-runtime-error] {run_exc}", level="ERROR")
            raise
        except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPStatusError) as exc:
            last_exc = exc
            log_fn(f"[deliver-exception] {type(exc).__name__}: {exc}", level="ERROR")
        except Exception as unexpected:
            last_exc = unexpected
            log_fn(f"[deliver-unexpected] {type(unexpected).__name__}: {unexpected}", level="ERROR")

        wait = _CALLBACK_BACKOFF_BASE ** (attempt - 1)
        log_fn(f"Callback attempt {attempt}/{_CALLBACK_MAX_ATTEMPTS} failed ({type(last_exc).__name__}: {last_exc}) — retry in {wait}s", level="WARNING")
        if attempt < _CALLBACK_MAX_ATTEMPTS:
            await asyncio.sleep(wait)

    raise RuntimeError(f"Callback delivery failed after {_CALLBACK_MAX_ATTEMPTS} attempts: {last_exc}")


async def main() -> None:
    task_info = payload["task"]
    project_info = payload["project"]
    github_info = payload.get("github") or {}
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

    prompt = (
        "TASK FOR FIGMA SCRIPTER:\n"
        f"{task_info['title']}\n"
        f"{task_info.get('description', '')}\n"
    )
    if ACTOR_ROLE:
        prompt += f"\nYour assigned role: {ACTOR_ROLE}\n"

    prompt += FILES_REMINDER

    log(f"prompt_length={len(prompt)} chars", level="DEBUG", phase="planning")
    log(f"system_prompt_length={len(SYSTEM_PROMPT)} chars", level="DEBUG", phase="planning")
    log(f"Using model: {MODEL}", level="DEBUG", phase="planning")

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

    files = parse_files_with_fallback(content, task_info["title"], log)
    log(f"Parsed {len(files)} file(s) from response")
    for f in files:
        log(f"[files] path={f['path']!r} size={len(f['content'])} bytes", level="DEBUG")

    # ── Build response: clean summary without truncated code ──────────────────
    summary_lines = []

    if files:
        summary_lines.append("✅ **Design files generated successfully:**\n")
        for file_obj in files:
            file_path = file_obj['path']
            file_size = len(file_obj['content'])
            lines_count = file_obj['content'].count('\n') + 1
            summary_lines.append(f"- `{file_path}` • {file_size:,} bytes • {lines_count} lines")
        summary_lines.append("\nClick the file names above or use the **View Files** button to open and download your generated design files.")
    else:
        summary_lines.append("⚠️ No design files were generated. Check the logs for details.")

    content = "\n".join(summary_lines)

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

    callback_body = {
        "task_id": task_id,
        "content": content,
        "files": files,
        "pr_url": pr_url,
        "logs": logs,
        "prompt": prompt,
        "model": MODEL,
    }

    log(f"[callback] Preparing payload with {len(files)} file(s) to send to {callback_url}")
    for f in files:
        log(f"[callback-files] Including: {f['path']} ({len(f['content'])} bytes)", level="DEBUG")

    log(f"Sending callback to {callback_url}")
    log(f"[callback-body] task_id={callback_body['task_id']} files={len(callback_body.get('files', []))} content_len={len(callback_body.get('content', ''))} logs={len(callback_body.get('logs', []))}", level="DEBUG")
    try:
        await _deliver_callback(callback_url, callback_token, callback_body, log)
        log("Callback delivered successfully")
    except RuntimeError as exc:
        log(f"Callback delivery permanently failed: {exc}", level="ERROR")
        raise SystemExit(1) from exc


if __name__ == "__main__":
    asyncio.run(main())
