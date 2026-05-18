from __future__ import annotations


def build_project_board_messages(
    project: dict,
    sprints: list[dict],
    tasks: list[dict],
    actors: list[dict],
    history: list[dict],
    user_prompt: str,
    memory_chunks: list[dict] | None = None,
    active_decisions: list[dict] | None = None,
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
    actors_lines = "\n".join(
        f'- id:{a["id"]} | {a["name"]} | {a.get("role","") or a.get("type","")} | {"AI" if a.get("type") == "ai" else "Human"}'
        for a in (actors or [])
    ) or "none"

    # Render memory + decisions so the assistant uses established facts and avoids
    # re-asking the user about things already captured.
    memory_section = ""
    if memory_chunks:
        lines = []
        for c in memory_chunks[:8]:
            title = c.get("title") or "(untitled)"
            summary = c.get("summary") or ""
            excerpt = (c.get("content") or "")[:600]
            lines.append(f"- [{c.get('source_type','memory')}] {title}\n  {summary}\n  {excerpt}")
        memory_section = (
            "\nRELEVANT PROJECT MEMORY (vector-matched to user's question) — established facts. "
            "TREAT AS ALREADY DECIDED. Never re-ask the user about anything stated here:\n"
            + "\n".join(lines)
            + "\n"
        )

    decisions_section = ""
    if active_decisions:
        dlines = [
            f"- {d.get('title','(untitled)')}: {d.get('decision','')}"
            + (f" — {d.get('reason')}" if d.get("reason") else "")
            for d in active_decisions[:10]
        ]
        decisions_section = (
            "\nACTIVE PROJECT DECISIONS (binding):\n" + "\n".join(dlines) + "\n"
        )

    return [
        {
            "role": "system",
            "content": (
                f"You are an AI project assistant.\n"
                f"Project: {project['name']}\n"
                f"Brief: {project.get('prompt', '')}\n"
                f"Sprints: {sprint_summary or 'none yet'}\n\n"
                f"Current tasks:\n{task_lines}\n\n"
                f"Team actors (use exact IDs when assigning):\n{actors_lines}\n"
                f"{memory_section}{decisions_section}\n"
                "Answer helpfully and concisely. Use the RELEVANT PROJECT MEMORY and "
                "ACTIVE PROJECT DECISIONS above as ground truth — do not contradict them "
                "and do not re-ask the user about facts already captured there.\n\n"
                "IMPORTANT - structured output rule:\n"
                "When the user asks to CREATE, ADD, DELETE, MODIFY, UPDATE, REGENERATE, or ADD DETAILS to tasks, "
                "respond ONLY with a single fenced JSON block - no prose before or after it.\n\n"
                "When creating tasks, always include an 'actor_id' if an actor clearly matches the task "
                "type or role (e.g. a designer for a design task, a backend dev for a code task). "
                "Use the exact actor id from the list above. Omit actor_id if no actor fits.\n\n"
                "When the user asks to assign a task to someone, respond ONLY with an assign_actor block.\n\n"
                "Shapes:\n"
                "```json\n"
                '{"intent":"create_tasks","tasks":[{"title":"...","description":"...","type":"code|design|review|research|qa|devops","priority":"low|medium|high","estimated_hours":2,"actor_id":"<actor id or omit>"}]}\n'
                "```\n"
                "```json\n"
                '{"intent":"modify_tasks","tasks":[{"id":"<existing task id>","title":"...","description":"...","type":"...","priority":"...","estimated_hours":2}]}\n'
                "```\n"
                "```json\n"
                '{"intent":"delete_tasks","tasks":[{"id":"<existing task id>","title":"..."}]}\n'
                "```\n"
                "```json\n"
                '{"intent":"assign_actor","task_id":"<existing task id>","actor_id":"<actor id>","actor_name":"<actor name>"}\n'
                "```\n"
                "For 'regenerate', use delete_tasks for old ones and create_tasks for new ones - pick whichever fits.\n"
                "For all other questions, answer normally using Markdown."
            ),
        },
        *history,
        {"role": "user", "content": user_prompt},
    ]
