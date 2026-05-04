from __future__ import annotations


def build_project_board_messages(
    project: dict,
    sprints: list[dict],
    tasks: list[dict],
    history: list[dict],
    user_prompt: str,
) -> list[dict]:
    """Build chat messages for project-board (kanban) assistant."""
    sprint_summary = ", ".join(
        f"Sprint {s['sprint_number']}" for s in (sprints or [])
    )
    task_lines = "\n".join(
        (
            f'- id:{t["id"]} | {t["title"]} | {t["status"]} '
            f'| {t.get("type","")} | {t.get("priority","")}'
        )
        for t in (tasks or [])
    ) or "no tasks yet"

    return [
        {
            "role": "system",
            "content": (
                f"You are an AI project assistant.\n"
                f"Project: {project['name']}\n"
                f"Brief: {project.get('prompt', '')}\n"
                f"Sprints: {sprint_summary or 'none yet'}\n\n"
                f"Current tasks:\n{task_lines}\n\n"
                "Answer helpfully and concisely.\n\n"
                "IMPORTANT - structured output rule:\n"
                "When the user asks to CREATE, ADD, DELETE, MODIFY, UPDATE, REGENERATE, or ADD DETAILS to tasks, "
                "respond ONLY with a single fenced JSON block - no prose before or after it.\n\n"
                "Shapes:\n"
                "```json\n"
                '{"intent":"create_tasks","tasks":[{"title":"...","description":"...","type":"feature|bug|chore|spike","priority":"low|medium|high","estimated_hours":2}]}\n'
                "```\n"
                "```json\n"
                '{"intent":"modify_tasks","tasks":[{"id":"<existing task id>","title":"...","description":"...","type":"...","priority":"...","estimated_hours":2}]}\n'
                "```\n"
                "```json\n"
                '{"intent":"delete_tasks","tasks":[{"id":"<existing task id>","title":"..."}]}\n'
                "```\n"
                "For 'regenerate', use delete_tasks for old ones and create_tasks for new ones - pick whichever fits.\n"
                "For all other questions, answer normally using Markdown."
            ),
        },
        *history,
        {"role": "user", "content": user_prompt},
    ]
