from __future__ import annotations

import json

from pydantic import BaseModel

from app.providers.registry import get_provider


class ProjectAssistBody(BaseModel):
    name: str = ""
    prompt: str = ""
    request: str = ""
    ai_model: str = "gpt-4o"


async def generate_project_creation_suggestion(body: ProjectAssistBody) -> dict[str, str]:
    """Generate a project name + prompt draft for the creation form."""
    user_request = (body.request or "").strip()
    seed_prompt = (body.prompt or "").strip()
    if not user_request and not seed_prompt:
        raise ValueError("Provide a request or a prompt draft")

    model = body.ai_model or "gpt-4o"
    provider = get_provider(model)
    messages = [
        {
            "role": "system",
            "content": (
                "You are a product/project scoping assistant. "
                "Return ONLY valid JSON with this exact shape: "
                '{"name":"...","prompt":"...","notes":"..."}. '
                "Keep 'name' concise (max 8 words). "
                "Make 'prompt' implementation-ready with sections: Goal, Scope, Non-goals, Tech context, Constraints, Acceptance criteria. "
                "Keep 'notes' very short (1-3 sentences)."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Current name: {body.name or '(empty)'}\\n"
                f"Current prompt draft:\\n{seed_prompt or '(empty)'}\\n\\n"
                f"Request:\\n{user_request or 'Help me draft this project clearly.'}"
            ),
        },
    ]

    raw = await provider.complete(messages)
    content = (raw or "").strip()
    if content.startswith("```"):
        content = content.strip("`")
        if content.lower().startswith("json"):
            content = content[4:].strip()

    try:
        parsed = json.loads(content)
    except Exception:
        # Fallback if model ignored JSON-only instruction
        return {
            "name": body.name or "New Project",
            "prompt": body.prompt or user_request,
            "notes": (raw or "")[:500],
        }

    return {
        "name": (parsed.get("name") or body.name or "New Project").strip(),
        "prompt": (parsed.get("prompt") or body.prompt or user_request).strip(),
        "notes": (parsed.get("notes") or "").strip(),
    }
