from __future__ import annotations

import json
from typing import List
from app.models import TaskDraft
from app.providers.registry import get_provider

BREAKDOWN_SYSTEM = """You are an expert technical project manager.
Given a product idea, produce a structured task breakdown as valid JSON.

Return a JSON object with key "tasks" containing an array of task objects.
Each task must have:
- title: string (short, action-oriented)
- description: string (2-4 sentences with acceptance criteria)
- type: one of [code, design, review, research, qa, devops]
- priority: one of [low, medium, high, critical]
- estimated_hours: number (realistic effort in hours)
- depends_on: array of 0-based indices of tasks this task depends on

Order tasks so that dependencies always appear before dependents.
Be thorough but realistic — aim for 10-25 tasks for most projects.
"""


async def breakdown_project(
    prompt: str,
    model: str = "gpt-4o",
) -> List[TaskDraft]:
    provider = get_provider(model)
    messages = [
        {"role": "system", "content": BREAKDOWN_SYSTEM},
        {
            "role": "user",
            "content": f"Break down this project into tasks:\n\n{prompt}",
        },
    ]
    raw = await provider.complete(
        messages,
        response_format={"type": "json_object"},
    )
    data = json.loads(raw)
    tasks_raw = data.get("tasks") or data.get("task_list") or []
    return [TaskDraft(**t) for t in tasks_raw]
