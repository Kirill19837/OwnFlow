from __future__ import annotations

import json
import re


def resolve_task_assistant_model_and_name(
    assignment_row: dict | None,
    actor_row: dict | None,
) -> tuple[str, str]:
    """Resolve model + display name for the task assistant."""
    model = "gpt-4o"
    assigned_actor_name = "Unassigned"
    if assignment_row and actor_row:
        assigned_actor_name = actor_row.get("name", "Actor")
        if actor_row.get("model"):
            model = actor_row["model"]
    return model, assigned_actor_name


def build_task_assistant_messages(
    task: dict,
    project: dict,
    actors: list[dict],
    history: list[dict],
    assigned_actor_name: str,
    task_details: dict,
    user_prompt: str,
) -> list[dict]:
    """Build chat messages for task assistant."""
    actors_lines = "\n".join(
        (
            f'- id:{a["id"]} | {a["name"]} '
            f'| {a.get("role","") or a.get("type","")} | {a.get("model","") or ""}'
        )
        for a in (actors or [])
    ) or "none"
    details_lines = (
        "\n".join(f"  {k}: {v}" for k, v in task_details.items())
        if task_details else "  (none captured yet)"
    )

    return [
        {
            "role": "system",
            "content": (
                f"You are {assigned_actor_name}, an AI agent working on a software project.\n"
                f"Project: {project.get('name', '')}\n"
                f"Project brief: {project.get('prompt', '')}\n\n"
                "Current task:\n"
                f"  Title: {task['title']}\n"
                f"  Description: {task.get('description') or '(empty)'}\n"
                f"  Status: {task['status']}  |  Type: {task['type']}  |  Priority: {task['priority']}\n\n"
                f"Decisions & details already captured:\n{details_lines}\n\n"
                f"Team actors (for assignment):\n{actors_lines}\n\n"
                "------------------------------------\n"
                "REFINEMENT PROTOCOL\n"
                "When the user asks you to refine, clarify, or improve this task "
                "(phrases like 'refine', 'clarify', 'improve description', 'what do you need', "
                "'ask me questions', 'fill in details', etc.), follow this exact process:\n\n"
                "STEP 1 - Rewrite title and description.\n"
                "  Emit one update_description action. Include a concise `title` (<= 10 words, plain text, no "
                "  markdown symbols) AND a full `content` description in markdown with: goal, acceptance "
                "  criteria, and any technical notes you can infer. The title should clearly name what "
                "  this task does.\n\n"
                "STEP 2 - Capture known structured decisions.\n"
                "  Emit one update_details action for every fact you can already infer from the "
                "  description, project context, or prior conversation. "
                "  Typical keys: tech_stack, database, auth_method, api_style, framework, "
                "  deployment_target, testing_approach, performance_requirements.\n"
                "  IMPORTANT: never emit a key that was already captured (shown above).\n\n"
                "STEP 3 - Ask all remaining open questions.\n"
                "  After the JSON blocks, list every question still unanswered as a numbered list. "
                "  Be specific - ask one thing per question. Do not ask about things already "
                "  captured in 'Decisions & details already captured'.\n\n"
                "STEP 4 - When the user answers a question.\n"
                "  Immediately emit update_details for the answered fact(s), then check if any "
                "  questions remain. If none remain, also emit mark_ready.\n\n"
                "mark_ready means: YOU (the AI) are confident the task has enough decisions to be\n"
                "implemented. It does NOT mean the user has approved execution - that is a separate\n"
                "human decision. Emit mark_ready only when you have all the information you need.\n"
                "Do NOT emit mark_ready until ALL questions are answered.\n"
                "Do NOT repeat questions already answered in the captured details.\n"
                "------------------------------------\n\n"
                "CONSOLIDATION PROTOCOL\n"
                "When the user says things like 'consolidate', 'take all decisions', 'collect decisions',\n"
                "'save everything we discussed', 'update decisions', 'consolidate from chat', 'save decisions':\n"
                "  1. Scan the ENTIRE conversation history for every decision, fact, or technical choice mentioned.\n"
                "  2. Emit ONE update_details block with ALL new facts not already in 'Decisions & details already captured'.\n"
                "  3. Do NOT emit update_description - NEVER touch title or description during consolidation.\n"
                "  4. After saving, assess: do you now have everything needed to implement this task?\n"
                "     If YES -> also emit mark_ready. If NO -> list what is still missing.\n"
                "------------------------------------\n\n"
                "STRUCTURED ACTIONS (respond with ONLY a fenced JSON block - no prose before/after):\n\n"
                "```json\n"
                '{"intent":"update_description","title":"<concise task name>","content":"<full markdown description>"}\n'
                "```\n"
                "```json\n"
                '{"intent":"update_details","details":{"<key>":"<value>",...}}\n'
                "```\n"
                "```json\n"
                '{"intent":"mark_ready","summary":"<one-sentence confirmation all questions answered>"}\n'
                "```\n"
                "```json\n"
                '{"intent":"assign_actor","actor_id":"<id>","actor_name":"..."}\n'
                "```\n"
                "```json\n"
                '{"intent":"update_status","status":"todo|in_progress|review|done|rework"}\n'
                "```\n"
                "```json\n"
                '{"intent":"execute_task","confirm":true}\n'
                "```\n\n"
                "When the refinement protocol produces multiple actions (steps 1+2), emit them as "
                "separate fenced JSON blocks in sequence, then ask questions in plain text after.\n"
                "For all other questions, answer normally using Markdown."
            ),
        },
        *history,
        {"role": "user", "content": user_prompt},
    ]


def strip_duplicate_task_details(text: str, existing: dict) -> str:
    """Remove keys already in existing from every update_details JSON block."""
    if not existing:
        return text

    def _clean(match: re.Match[str]) -> str:
        try:
            obj = json.loads(match.group(1))
            if obj.get("intent") == "update_details" and isinstance(obj.get("details"), dict):
                obj["details"] = {k: v for k, v in obj["details"].items() if k not in existing}
                if not obj["details"]:
                    return ""
                return f"```json\\n{json.dumps(obj)}\\n```"
        except Exception:
            pass
        return match.group(0)

    return re.sub(r"```json\s*({.*?})\s*```", _clean, text, flags=re.DOTALL)


def has_mark_ready_action(text: str) -> bool:
    """Return True if assistant emitted mark_ready in any fenced JSON action."""
    for match in re.finditer(r"```json\s*({.*?})\s*```", text, flags=re.DOTALL):
        try:
            obj = json.loads(match.group(1))
            if obj.get("intent") == "mark_ready":
                return True
        except Exception:
            continue
    return False
