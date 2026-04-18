from __future__ import annotations

import json
import uuid
from typing import List, Optional
from app.models import TaskDraft, SprintTheme
from app.providers.registry import get_provider
from app.db import get_supabase

SPRINT_ONE_SYSTEM = """You are an expert technical project manager.
Given a product idea, produce a high-level project roadmap and a detailed Sprint 1 task breakdown as valid JSON.

Return a JSON object with:
- "roadmap": array of sprint theme objects, each with:
  - "sprint_number": integer (1-based)
  - "theme": string (short name, e.g. "Foundation & Setup")
  - "goal": string (1-2 sentences describing the sprint's objective)
- "sprint1_tasks": array of task objects for Sprint 1 only, each with:
  - "title": string (short, action-oriented)
  - "description": string (2-4 sentences with acceptance criteria)
  - "type": one of [code, design, review, research, qa, devops]
  - "priority": one of [low, medium, high, critical]
  - "estimated_hours": number (realistic effort in hours)
  - "depends_on": array of 0-based indices of tasks this task depends on (within sprint1_tasks only)

The roadmap should cover the full project in 3-6 sprints. Sprint 1 tasks must fit within 24 hours of total effort and focus on the foundation/setup goals from the roadmap.
Order sprint1_tasks so dependencies always appear before dependents.
"""

NEXT_SPRINT_SYSTEM = """You are an expert technical project manager continuing a project plan.
Given the project description, roadmap, and summary of completed work, generate detailed tasks for the next sprint.

Return a JSON object with:
- "tasks": array of task objects, each with:
  - "title": string (short, action-oriented)
  - "description": string (2-4 sentences with acceptance criteria)
  - "type": one of [code, design, review, research, qa, devops]
  - "priority": one of [low, medium, high, critical]
  - "estimated_hours": number (realistic effort in hours)
  - "depends_on": array of 0-based indices of tasks this task depends on

Tasks must align with the sprint's theme and goal from the roadmap.
Total estimated hours should not exceed 24 hours.
Order tasks so dependencies always appear before dependents.
"""


def _persist_ai_message(project_id: str, phase: str, model: str, messages: list, response: str) -> None:
    try:
        db = get_supabase()
        db.table("ai_messages").insert({
            "id": str(uuid.uuid4()),
            "project_id": project_id,
            "phase": phase,
            "model": model,
            "messages": messages,
            "response": response,
        }).execute()
    except Exception:
        pass


async def plan_sprint_one(
    prompt: str,
    model: str = "gpt-4o",
    project_id: Optional[str] = None,
) -> tuple[List[TaskDraft], List[SprintTheme]]:
    """Generate the full roadmap + Sprint 1 tasks. Persists roadmap to projects table."""
    provider = get_provider(model)
    messages = [
        {"role": "system", "content": SPRINT_ONE_SYSTEM},
        {"role": "user", "content": f"Plan this project:\n\n{prompt}"},
    ]
    raw = await provider.complete(messages, response_format={"type": "json_object"})

    if project_id:
        _persist_ai_message(project_id, "planning_sprint1", model, messages, raw)

    data = json.loads(raw)
    roadmap_raw = data.get("roadmap") or []
    tasks_raw = data.get("sprint1_tasks") or data.get("tasks") or []

    roadmap = [SprintTheme(**r) for r in roadmap_raw]
    sprint1_tasks = [TaskDraft(**t) for t in tasks_raw]

    # Persist roadmap to the project row
    if project_id and roadmap:
        try:
            db = get_supabase()
            db.table("projects").update({
                "roadmap": [r.model_dump() for r in roadmap]
            }).eq("id", project_id).execute()
        except Exception:
            pass

    return sprint1_tasks, roadmap


async def generate_next_sprint(
    project_id: str,
    sprint_number: int,
    model: str = "gpt-4o",
) -> List[TaskDraft]:
    """Generate tasks for the next sprint using stored roadmap + completed sprint context."""
    db = get_supabase()

    project = db.table("projects").select("prompt,roadmap").eq("id", project_id).single().execute()
    if not project.data:
        raise ValueError("Project not found")

    prompt = project.data["prompt"]
    roadmap = project.data.get("roadmap") or []

    # Find the theme for this sprint
    sprint_theme = next((r for r in roadmap if r.get("sprint_number") == sprint_number), None)
    theme_text = ""
    if sprint_theme:
        theme_text = f"\nSprint {sprint_number} theme: {sprint_theme.get('theme')}\nGoal: {sprint_theme.get('goal')}"

    # Summarize completed sprints
    completed_sprints = (
        db.table("sprints")
        .select("sprint_number, status")
        .eq("project_id", project_id)
        .lt("sprint_number", sprint_number)
        .order("sprint_number")
        .execute()
    )
    completed_task_titles = []
    if completed_sprints.data:
        sprint_ids = [s["id"] for s in completed_sprints.data if "id" in s]
        if sprint_ids:
            tasks_resp = db.table("tasks").select("title,status").in_("sprint_id", sprint_ids).execute()
            completed_task_titles = [t["title"] for t in (tasks_resp.data or [])]

    completed_summary = ""
    if completed_task_titles:
        completed_summary = "\n\nCompleted work from previous sprints:\n" + "\n".join(f"- {t}" for t in completed_task_titles)

    roadmap_text = ""
    if roadmap:
        roadmap_text = "\n\nFull project roadmap:\n" + "\n".join(
            f"- Sprint {r.get('sprint_number')}: {r.get('theme')} — {r.get('goal')}"
            for r in roadmap
        )

    provider = get_provider(model)
    messages = [
        {"role": "system", "content": NEXT_SPRINT_SYSTEM},
        {
            "role": "user",
            "content": (
                f"Project description:\n{prompt}"
                f"{roadmap_text}"
                f"{theme_text}"
                f"{completed_summary}"
                f"\n\nGenerate tasks for Sprint {sprint_number}."
            ),
        },
    ]
    raw = await provider.complete(messages, response_format={"type": "json_object"})
    _persist_ai_message(project_id, f"planning_sprint{sprint_number}", model, messages, raw)

    data = json.loads(raw)
    tasks_raw = data.get("tasks") or []
    return [TaskDraft(**t) for t in tasks_raw]


# Keep backward-compatible alias
async def breakdown_project(
    prompt: str,
    model: str = "gpt-4o",
    project_id: Optional[str] = None,
) -> List[TaskDraft]:
    tasks, _ = await plan_sprint_one(prompt, model, project_id)
    return tasks
