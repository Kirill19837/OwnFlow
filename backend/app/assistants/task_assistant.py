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
    memory_chunks: list[dict] | None = None,
    active_decisions: list[dict] | None = None,
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

    # Build memory section from the top-K relevant chunks (already filtered by
    # vector similarity in the calling endpoint).
    memory_section = ""
    if memory_chunks:
        lines = []
        for c in memory_chunks:
            content = (c.get("content") or "").strip()
            if len(content) <= 600:
                body = content or (c.get("summary") or "")
            else:
                body = (c.get("summary") or "") + "\n" + content[:600]
            lines.append(f"  [{c['source_type']}] {c['title']}:\n    {body}")
        memory_section = (
            "RELEVANT PROJECT MEMORY (vector-matched to current task) — established facts. "
            "TREAT AS ALREADY DECIDED. Never re-ask the user about anything stated here; "
            "capture it via update_details and continue:\n"
            + "\n".join(lines)
            + "\n\n"
        )

    decisions_section = ""
    if active_decisions:
        lines = [f"  - {d['title']}: {d['decision']}" for d in active_decisions]
        decisions_section = (
            "ACTIVE ARCHITECTURAL DECISIONS — treat as final, do NOT re-ask:\n"
            + "\n".join(lines)
            + "\n\n"
        )

    return [
        {
            "role": "system",
            "content": (
                f"You are {assigned_actor_name}, an AI agent working on a software project.\n"
                f"Project: {project.get('name', '')}\n"
                f"Project brief: {project.get('prompt', '')}\n\n"
                f"{memory_section}"
                f"{decisions_section}"
                "Current task:\n"
                f"  Title: {task['title']}\n"
                f"  Description: {task.get('description') or '(empty)'}\n"
                f"  Status: {task['status']}  |  Type: {task['type']}  |  Priority: {task['priority']}\n\n"
                f"Decisions & details already captured:\n{details_lines}\n\n"
                f"Team actors (for assignment):\n{actors_lines}\n\n"
                "------------------------------------\n"
                "EXPECTED OUTPUT (based on task type)\n"
                "The task type determines what the AI agent will produce when executed.\n"
                "Always clarify the exact expected deliverable with the user during refinement.\n\n"
                "  code    → Source code files + tests. Ask: language/framework, entry point,\n"
                "            file paths, test framework, whether to include CI config.\n"
                "  design  → Design spec or UI component doc. Ask: target platform (web/mobile),\n"
                "            design system (Tailwind/MUI/custom), component states, accessibility reqs.\n"
                "  review  → Written review report (Markdown doc). Ask: what to review (PR/code/doc/arch),\n"
                "            review criteria, audience (team/stakeholders), format (checklist/narrative).\n"
                "  research → Research report or analysis (Markdown doc). Ask: scope, key questions,\n"
                "            format (executive summary / deep dive), sources to consider.\n"
                "  qa      → Test plan + test cases (or bug report). Ask: scope (unit/integration/e2e),\n"
                "            framework (pytest/jest/cypress), happy-path + edge cases to cover.\n"
                "  devops  → Config/script/pipeline files. Ask: target environment (AWS/GCP/k8s/VPS),\n"
                "            tooling (Docker/Terraform/GitHub Actions), secrets strategy.\n\n"
                "CRITICAL: Ask the user about the DELIVERABLE FORMAT early in refinement.\n"
                "Examples of output_format to clarify and save:\n"
                "  - 'document_in_markdown_on_repo' / 'source_control_document'\n"
                "  - 'code_files_in_repo' / 'source_control_code'\n"
                "  - 'figma_design' / 'design_file'\n"
                "  - 'google_doc' / 'external_document'\n"
                "  - 'github_pr' / 'github_gist'\n"
                "  - 'slack_message' / 'report_link'\n"
                "Once clarified, save it with key 'output_format' in update_details.\n"
                "Include a brief 'Expected output:' statement in your refinement reply so the user\n"
                "knows what the agent will produce. When emitting mark_ready, the summary MUST\n"
                "state the concrete deliverable (e.g. 'Python FastAPI endpoint in src/api/users.py\n"
                "with pytest tests' and 'delivered as code_files_in_repo').\n"
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
                "  description, project context, RELEVANT PROJECT MEMORY, ACTIVE ARCHITECTURAL\n"
                "  DECISIONS, or prior conversation. Scan memory carefully — if memory says the\n"
                "  project uses React, capture tech_stack='React' immediately. If memory says\n"
                "  the API style is REST, capture api_style='REST'. Do NOT ask the user about\n"
                "  anything that memory already answers.\n"
                "  ALWAYS capture 'output_format' first (see examples above), then include other\n"
                "  typical keys: tech_stack, database, auth_method, api_style, framework, "
                "  deployment_target, testing_approach, performance_requirements.\n"
                "  IMPORTANT: never emit a key that was already captured (shown above).\n\n"
                "STEP 3 - Ask ONE question at a time.\n"
                "  GATE CHECK: Before asking ANY question, FIRST check:\n"
                "    a) 'RELEVANT PROJECT MEMORY' section above\n"
                "    b) 'ACTIVE ARCHITECTURAL DECISIONS' section above\n"
                "    c) 'Decisions & details already captured' section above\n"
                "  If the answer appears in ANY of those three sources, you MUST:\n"
                "    → Emit update_details with the value from memory\n"
                "    → Skip to the next question in priority order\n"
                "    → Do NOT ask the user to confirm a fact from memory\n"
                "  Only ask the user if none of the three sources answer the question.\n"
                "  Identify ALL remaining open questions, but ask ONLY THE SINGLE most important\n"
                "  one in this turn. Priority order:\n"
                "    1. output_format (if not yet captured)\n"
                "    2. tech_stack / framework (if not yet captured)\n"
                "    3. architecture / approach (api_style, deployment_target, etc.)\n"
                "    4. testing / quality (testing_approach, coverage)\n"
                "    5. nice-to-haves (security scanning, performance reqs, etc.)\n"
                "  Format: after the JSON blocks, output exactly ONE plain-text question.\n"
                "  No numbered list, no bullet list, no 'Critical Open Questions' header.\n"
                "  If you must offer options, inline them in the question sentence\n"
                "  (e.g. 'Should we use React, Vue, or Svelte?').\n"
                "  Do not ask about things already captured in 'Decisions & details already captured'.\n\n"
                "STEP 4 - When the user answers a question.\n"
                "  a) Emit update_details immediately with every newly answered fact.\n"
                "  b) After emitting update_details, ask yourself: 'Are there any open questions\n"
                "     left that a developer absolutely needs before starting?'\n"
                "       - If YES → ask the NEXT single highest-priority question (one only,\n"
                "         no list), following the STEP 3 priority order. Do NOT emit mark_ready.\n"
                "       - If NO → also emit mark_ready in the SAME response. Do NOT wait for the\n"
                "         next turn.\n"
                "  c) 'No open questions' means: output_format is captured AND the core technical\n"
                "     decisions (tech stack, approach, acceptance criteria) are known. Minor nice-\n"
                "     to-haves that a developer can decide on their own do NOT block mark_ready.\n\n"
                "mark_ready means: you are confident a developer can START without asking more\n"
                "questions. Emit it as soon as that condition is met — even if every possible\n"
                "detail has not been spelled out. A task ready to implement does NOT need to be\n"
                "100% specified; it needs to be 'good enough to start'.\n"
                "Always pair mark_ready with a preceding update_details block in the same reply.\n"
                "Do NOT repeat questions already answered in the captured details.\n"
                "------------------------------------\n\n"
                "CONSOLIDATION PROTOCOL\n"
                "When the user says things like 'consolidate', 'take all decisions', 'collect decisions',\n"
                "'save everything we discussed', 'update decisions', 'consolidate from chat', 'save decisions':\n"
                "  1. Scan the ENTIRE conversation history for every decision, fact, or technical choice mentioned.\n"
                "  2. Emit ONE update_details block with ALL new facts not already in 'Decisions & details already captured'.\n"
                "  3. Do NOT emit update_description - NEVER touch title or description during consolidation.\n"
                "  4. After saving, assess: can a developer START this task without asking\n"
                "     more questions? If YES → emit mark_ready immediately. If NO → list exactly\n"
                "     what is still missing (keep it short — only blockers, not nice-to-haves).\n"
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
                "For all other questions, answer normally using Markdown.\n\n"
                "------------------------------------\n"
                "FORBIDDEN META-KEYS\n"
                "Project memory persistence is AUTOMATIC. Every time you emit update_details with\n"
                "real task content, the backend writes it to project memory. The user never needs\n"
                "to ask for it, and you must NEVER invent meta-keys such as:\n"
                "  task_memory_persisted, all_refinements_saved, execution_ready, timestamp,\n"
                "  memory_saved, refinement_complete, persisted, saved, ready.\n"
                "These keys are meaningless and pollute task_details.\n"
                "If the user says 'save to memory', 'persist', 'save everything' or similar:\n"
                "  → Run the CONSOLIDATION PROTOCOL (scan history, emit ONE update_details with\n"
                "    real keys like tech_stack, output_format, etc.). If nothing new to save,\n"
                "    reply in plain text: 'All decisions are already saved — project memory is\n"
                "    updated automatically.' Do NOT emit any JSON block in that case.\n"
                "Only real, concrete task facts belong in update_details."
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
