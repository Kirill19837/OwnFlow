from __future__ import annotations

import json

from pydantic import BaseModel

from app.providers.registry import get_provider


class ProjectAssistBody(BaseModel):
    name: str = ""
    prompt: str = ""
    request: str = ""
    ai_model: str = "gpt-4o"
    document_texts: list[str] = []
    company_id: str = ""


async def generate_project_creation_suggestion(body: ProjectAssistBody) -> dict[str, str]:
    """Generate a project name + prompt draft for the creation form."""
    user_request = (body.request or "").strip()
    seed_prompt = (body.prompt or "").strip()
    if not user_request and not seed_prompt and not body.document_texts:
        raise ValueError("Provide a request, a prompt draft, or upload documents")

    model = body.ai_model or "gpt-4o"
    provider = get_provider(model)

    docs_section = ""
    if body.document_texts:
        excerpts = []
        for text in body.document_texts[:4]:
            excerpts.append(text[:4000])
        docs_section = (
            "\n\nUPLOADED PROJECT DOCUMENTS (extract key requirements, goals, and constraints from these):\n"
            + "\n\n---\n\n".join(excerpts)
        )

    messages = [
        {
            "role": "system",
            "content": (
                "You are a product/project scoping assistant. "
                "Return ONLY valid JSON with this exact shape: "
                '{"name":"...","prompt":"...","notes":"...","questions":[]}. '
                "Populate 'questions' with 2-4 short clarifying questions when the brief is "
                "vague or missing key information (e.g. available engineer-hours, deadline, "
                "preferred tech stack, team size, or acceptance criteria). "
                "Leave 'questions' as an empty list if the brief is already detailed enough "
                "to write a solid implementation plan. "
                "Example questions: 'How many engineer-hours are budgeted for this?', "
                "'What is the target release date?', 'Any preferred tech stack or constraints?', "
                "'How many people will work on this?'. "
                "Keep 'name' concise (max 8 words). "
                "Make 'prompt' implementation-ready with sections: Goal, Scope, Non-goals, "
                "Tech context, Constraints, Acceptance criteria. "
                "Keep 'notes' very short (1-3 sentences)."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Current name: {body.name or '(empty)'}\\n"
                f"Current prompt draft:\\n{seed_prompt or '(empty)'}\\n\\n"
                f"Request:\\n{user_request or 'Analyse the uploaded documents and draft a full implementation-ready project brief.'}"
                f"{docs_section}"
            ),
        },
    ]

    # Check AI prompt limit if company_id is provided
    if body.company_id:
        from app.services.usage_guard import check_and_increment_by_company
        check_and_increment_by_company(body.company_id)

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
            "questions": [],
        }

    return {
        "name": (parsed.get("name") or body.name or "New Project").strip(),
        "prompt": (parsed.get("prompt") or body.prompt or user_request).strip(),
        "notes": (parsed.get("notes") or "").strip(),
        "questions": parsed.get("questions") or [],
    }
