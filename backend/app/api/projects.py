from __future__ import annotations

from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends
from fastapi.responses import StreamingResponse
from app.models import ProjectCreate, ActorCreate
from app.db import get_supabase
from app.services.ai_orchestrator import breakdown_project, plan_sprint_one, generate_next_sprint
from app.services.sprint_planner import plan_and_persist
from app.services.assignment_engine import auto_assign
from app.providers.registry import get_provider
from app.auth_deps import current_user_id
from app.assistants import (
    ProjectAssistBody,
    build_project_board_messages,
    generate_project_creation_suggestion,
)
import uuid
import json

router = APIRouter()


@router.post("/assist")
async def assist_project_creation(body: ProjectAssistBody, _caller_id: str = Depends(current_user_id)):
    """Generate a better project name/prompt draft before project creation."""
    try:
        return await generate_project_creation_suggestion(body)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"AI assistant failed: {exc}")


@router.post("", status_code=201)
async def create_project(body: ProjectCreate, background_tasks: BackgroundTasks):
    db = get_supabase()
    project_id = str(uuid.uuid4())

    # Resolve AI model: explicit override > org default > system default
    ai_model = body.ai_model or "gpt-4o"
    if body.team_id:
        org = db.table("teams").select("default_ai_model").eq("id", body.team_id).single().execute()
        if org.data:
            ai_model = body.ai_model or org.data["default_ai_model"]

    row = {
        "id": project_id,
        "name": body.name,
        "prompt": body.prompt,
        "owner_id": body.owner_id,
        "team_id": body.team_id,
        "sprint_days": body.sprint_days,
        "status": "planning",
    }
    db.table("projects").insert(row).execute()

    if body.auto_plan:
        background_tasks.add_task(_run_planning, project_id, body.prompt, ai_model, body.sprint_days)
    return {"id": project_id, "status": "planning", "ai_model": ai_model}


async def _run_planning(project_id: str, prompt: str, ai_model: str = "gpt-4o", sprint_days: int = 3):
    db = get_supabase()
    try:
        tasks = await breakdown_project(prompt, model=ai_model)
        await plan_and_persist(project_id, tasks, sprint_days=sprint_days)

        # Auto-assign all sprints
        sprints_resp = (
            db.table("sprints").select("id").eq("project_id", project_id).execute()
        )
        for sprint in sprints_resp.data or []:
            await auto_assign(sprint["id"])

        db.table("projects").update({"status": "active"}).eq("id", project_id).execute()
    except Exception:
        db.table("projects").update({"status": "error"}).eq("id", project_id).execute()
        raise


@router.get("/{project_id}/plan/stream")
async def plan_stream(project_id: str, ai_model: str = "gpt-4o"):
    db = get_supabase()
    project_resp = db.table("projects").select("name,prompt,sprint_days").eq("id", project_id).single().execute()
    if not project_resp.data:
        raise HTTPException(404, "Project not found")
    project = project_resp.data
    sprint_days: int = project.get("sprint_days") or 3

    async def event_stream():
        def _persist_log(msg: str, level: str = "info") -> None:
            try:
                db.table("ai_logs").insert({
                    "id": str(uuid.uuid4()),
                    "project_id": project_id,
                    "phase": "planning",
                    "message": msg,
                    "level": level,
                }).execute()
            except Exception:
                pass

        def _log(msg: str, level: str = "info") -> str:
            _persist_log(msg, level)
            return f"data: {json.dumps({'type': 'log', 'message': msg})}\n\n"

        try:
            yield _log(f"🔍 Analyzing project: {project['name']!r}")
            yield _log(f"⚙️  Calling {ai_model} to generate roadmap + Sprint 1 breakdown…")

            sprint1_tasks, roadmap = await plan_sprint_one(project["prompt"], model=ai_model, project_id=project_id)
            yield _log(f"🗺️  Roadmap: {len(roadmap)} sprints planned")
            yield _log(f"📋 Sprint 1: {len(sprint1_tasks)} tasks generated")

            yield _log("📅 Organizing Sprint 1 tasks…")
            await plan_and_persist(project_id, sprint1_tasks, start_sprint_number=0, sprint_days=sprint_days)

            sprints_resp = db.table("sprints").select("id").eq("project_id", project_id).execute()
            sprint_count = len(sprints_resp.data or [])
            yield _log(f"🗂️  Created {sprint_count} sprint(s) — more sprints planned on-demand")

            yield _log("🤖 Auto-assigning tasks to actors…")
            for sprint in sprints_resp.data or []:
                await auto_assign(sprint["id"])

            db.table("projects").update({"status": "active"}).eq("id", project_id).execute()
            yield _log("✅ Project plan is ready!")
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as exc:
            _persist_log(str(exc), "error")
            db.table("projects").update({"status": "error"}).eq("id", project_id).execute()
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/{project_id}")
def get_project(project_id: str):
    db = get_supabase()
    project = db.table("projects").select("*").eq("id", project_id).single().execute()
    if not project.data:
        raise HTTPException(404, "Project not found")

    sprints = (
        db.table("sprints")
        .select("*")
        .eq("project_id", project_id)
        .order("sprint_number")
        .execute()
    )
    sprint_ids = [s["id"] for s in sprints.data or []]

    tasks = []
    if sprint_ids:
        tasks_resp = (
            db.table("tasks")
            .select("*, assignments(*, actors(*))")
            .in_("sprint_id", sprint_ids)
            .execute()
        )
        tasks = tasks_resp.data or []

    actors = (
        db.table("actors").select("*").eq("project_id", project_id).execute()
    )

    return {
        **project.data,
        "sprints": sprints.data or [],
        "tasks": tasks,
        "actors": actors.data or [],
    }


@router.get("")
def list_projects(owner_id: str = "", team_id: str = ""):
    db = get_supabase()
    q = db.table("projects").select("*").order("created_at", desc=True)
    if team_id:
        q = q.eq("team_id", team_id)
    elif owner_id:
        q = q.eq("owner_id", owner_id)
    else:
        return []
    return q.execute().data or []


@router.post("/{project_id}/actors", status_code=201)
def add_actor(project_id: str, body: ActorCreate):
    db = get_supabase()
    row = {
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        "name": body.name,
        "type": body.type,
        "role": body.role,
        "model": body.model,
        "capabilities": body.capabilities,
        "avatar_url": body.avatar_url,
    }
    if body.user_id:
        row["user_id"] = body.user_id
    db.table("actors").insert(row).execute()
    return row


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str):
    db = get_supabase()
    project = db.table("projects").select("id").eq("id", project_id).single().execute()
    if not project.data:
        raise HTTPException(404, "Project not found")
    db.table("projects").delete().eq("id", project_id).execute()


@router.patch("/{project_id}/settings", status_code=200)
def update_project_settings(project_id: str, body: dict):
    """Update editable project settings: name, sprint_days."""
    db = get_supabase()
    project = db.table("projects").select("id").eq("id", project_id).single().execute()
    if not project.data:
        raise HTTPException(404, "Project not found")
    allowed = {"name", "prompt", "sprint_days"}
    update = {k: v for k, v in body.items() if k in allowed}
    if not update:
        raise HTTPException(400, "No valid settings to update")
    if "sprint_days" in update:
        if not isinstance(update["sprint_days"], int) or update["sprint_days"] < 1 or update["sprint_days"] > 30:
            raise HTTPException(400, "sprint_days must be an integer between 1 and 30")
    try:
        db.table("projects").update(update).eq("id", project_id).execute()
    except Exception as e:
        raise HTTPException(500, f"DB update failed: {e}")
    return {"id": project_id, **update}


@router.post("/{project_id}/regenerate", status_code=200)
async def regenerate_plan(project_id: str):
    """Wipe all sprints/tasks/assignments for a project and re-run planning via the stream endpoint."""
    db = get_supabase()
    project = db.table("projects").select("id,prompt").eq("id", project_id).single().execute()
    if not project.data:
        raise HTTPException(404, "Project not found")

    # Delete existing sprints (cascade deletes tasks + assignments)
    db.table("sprints").delete().eq("project_id", project_id).execute()
    # Reset status back to planning
    db.table("projects").update({"status": "planning", "roadmap": None}).eq("id", project_id).execute()
    return {"id": project_id, "status": "planning"}


@router.post("/{project_id}/sprints/next", status_code=201)
async def plan_next_sprint(project_id: str, ai_model: str = "gpt-4o"):
    """Generate tasks for the next sprint using stored roadmap + completed sprint context."""
    db = get_supabase()

    project = db.table("projects").select("id,roadmap,sprint_days").eq("id", project_id).single().execute()
    if not project.data:
        raise HTTPException(404, "Project not found")
    if not project.data.get("roadmap"):
        raise HTTPException(400, "No roadmap found. Run initial planning first.")
    sprint_days: int = project.data.get("sprint_days") or 3

    # Find the highest existing sprint number
    existing = (
        db.table("sprints")
        .select("sprint_number")
        .eq("project_id", project_id)
        .order("sprint_number", desc=True)
        .limit(1)
        .execute()
    )
    last_sprint_num = existing.data[0]["sprint_number"] if existing.data else 0
    next_sprint_num = last_sprint_num + 1

    # Check the roadmap has a theme for this sprint
    roadmap = project.data["roadmap"]
    max_sprint = max((r.get("sprint_number", 0) for r in roadmap), default=0)
    if next_sprint_num > max_sprint:
        raise HTTPException(400, f"All {max_sprint} planned sprints already exist. Roadmap is complete.")

    # Generate tasks for next sprint
    tasks = await generate_next_sprint(project_id, next_sprint_num, model=ai_model)
    if not tasks:
        raise HTTPException(500, "AI returned no tasks for the next sprint")

    # Persist sprint with correct number offset
    result = await plan_and_persist(project_id, tasks, start_sprint_number=last_sprint_num, sprint_days=sprint_days)

    # Auto-assign
    new_sprints = (
        db.table("sprints")
        .select("id")
        .eq("project_id", project_id)
        .eq("sprint_number", next_sprint_num)
        .execute()
    )
    for sprint in new_sprints.data or []:
        await auto_assign(sprint["id"])

    return {
        "sprint_number": next_sprint_num,
        "task_count": result["task_count"],
    }


@router.post("/{project_id}/tasks", status_code=201)
async def create_tasks_for_project(project_id: str, body: dict):
    """Create one or more tasks in a sprint from the AI suggestion."""
    db = get_supabase()
    tasks_in = body.get("tasks") or []
    if not tasks_in:
        raise HTTPException(400, "tasks list is required")

    sprint_id = body.get("sprint_id")
    if not sprint_id:
        sr = (
            db.table("sprints")
            .select("id")
            .eq("project_id", project_id)
            .order("sprint_number")
            .limit(1)
            .execute()
        )
        if not sr.data:
            raise HTTPException(400, "No sprints found — plan the project first")
        sprint_id = sr.data[0]["id"]

    rows = []
    for t in tasks_in:
        rows.append(
            {
                "id": str(uuid.uuid4()),
                "sprint_id": sprint_id,
                "project_id": project_id,
                "title": (t.get("title") or "Untitled").strip(),
                "description": t.get("description") or "",
                "type": t.get("type") or "feature",
                "priority": t.get("priority") or "medium",
                "estimated_hours": float(t.get("estimated_hours") or 1),
                "status": "todo",
                "depends_on": [],
            }
        )

    result = db.table("tasks").insert(rows).execute()
    return {"created": len(rows), "tasks": result.data or []}


@router.patch("/{project_id}/tasks/batch")
async def batch_modify_tasks(project_id: str, body: dict):
    """Bulk-update tasks. Each item must have an 'id' plus the fields to change."""
    db = get_supabase()
    tasks_in = body.get("tasks") or []
    if not tasks_in:
        raise HTTPException(400, "tasks list is required")
    updated = []
    allowed_fields = {"title", "description", "type", "priority", "estimated_hours", "status"}
    for t in tasks_in:
        task_id = t.get("id")
        if not task_id:
            continue
        patch = {k: v for k, v in t.items() if k in allowed_fields and v is not None}
        if patch:
            r = db.table("tasks").update(patch).eq("id", task_id).eq("project_id", project_id).execute()
            if r.data:
                updated.extend(r.data)
    return {"updated": len(updated), "tasks": updated}


@router.delete("/{project_id}/tasks/batch")
async def batch_delete_tasks(project_id: str, body: dict):
    """Bulk-delete tasks by ID list."""
    db = get_supabase()
    task_ids = [t.get("id") for t in (body.get("tasks") or []) if t.get("id")]
    if not task_ids:
        raise HTTPException(400, "tasks list with ids is required")
    db.table("tasks").delete().in_("id", task_ids).eq("project_id", project_id).execute()
    return {"deleted": len(task_ids)}


@router.post("/{project_id}/prompt/stream")
async def prompt_project_stream(project_id: str, body: dict):
    """Stream a free-form AI prompt with full project + sprint context."""
    db = get_supabase()
    user_prompt = (body.get("prompt") or "").strip()
    if not user_prompt:
        raise HTTPException(400, "prompt is required")

    project_resp = db.table("projects").select("*").eq("id", project_id).single().execute()
    project = project_resp.data
    if not project:
        raise HTTPException(404, "Project not found")

    # Gather sprint + task summary for context
    sprints_resp = db.table("sprints").select("id,sprint_number").eq("project_id", project_id).execute()
    sprint_ids = [s["id"] for s in sprints_resp.data or []]
    tasks_resp = db.table("tasks").select("id,title,status,type,priority,estimated_hours").in_("sprint_id", sprint_ids).execute() if sprint_ids else type("R", (), {"data": []})()

    history = body.get("history") or []
    messages = build_project_board_messages(
        project=project,
        sprints=sprints_resp.data or [],
        tasks=tasks_resp.data or [],
        history=history,
        user_prompt=user_prompt,
    )

    model = "gpt-4o"
    provider = get_provider(model)

    async def event_stream():
        async for chunk in provider.stream(messages):
            yield f"data: {json.dumps({'content': chunk})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/{project_id}/run-ready")
async def run_ready_tasks(project_id: str, background_tasks: BackgroundTasks):
    """Execute all tasks that are marked is_ready=true and have an AI actor assigned."""
    from app.services.actor_executor import execute_task

    db = get_supabase()

    # Get all sprint IDs for project
    sprints = db.table("sprints").select("id").eq("project_id", project_id).execute()
    sprint_ids = [s["id"] for s in (sprints.data or [])]
    if not sprint_ids:
        return {"queued": 0}

    # Find ready tasks with assigned AI actors
    tasks_resp = (
        db.table("tasks")
        .select("id, title, assignments(actor_id, actors(type))")
        .in_("sprint_id", sprint_ids)
        .eq("is_ready", True)
        .execute()
    )
    tasks = tasks_resp.data or []

    queued = []
    for task in tasks:
        assignments = task.get("assignments") or []
        if isinstance(assignments, dict):
            assignments = [assignments]
        for asgn in assignments:
            actor = asgn.get("actors") or {}
            if actor.get("type") == "ai":
                actor_id = asgn["actor_id"]
                db.table("tasks").update({"status": "in_progress"}).eq("id", task["id"]).execute()
                background_tasks.add_task(execute_task, task["id"], actor_id)
                queued.append(task["id"])
                break

    return {"queued": len(queued), "task_ids": queued}


@router.get("/{project_id}/activity")
async def get_project_activity(project_id: str):
    """Return all task interactions + task_details decisions for the project."""
    db = get_supabase()

    # Get all sprint IDs then all tasks for project
    sprints = db.table("sprints").select("id").eq("project_id", project_id).execute()
    sprint_ids = [s["id"] for s in (sprints.data or [])]

    if not sprint_ids:
        return {"interactions": [], "decisions": []}

    tasks_resp = (
        db.table("tasks")
        .select("id,title,task_details,sprint_id")
        .in_("sprint_id", sprint_ids)
        .order("title")
        .execute()
    )
    tasks = tasks_resp.data or []
    task_ids = [t["id"] for t in tasks]
    task_map = {t["id"]: t["title"] for t in tasks}

    # Fetch all interactions across all tasks
    interactions: list[dict] = []
    if task_ids:
        inter_resp = (
            db.table("task_interactions")
            .select("id,task_id,role,content,created_at")
            .in_("task_id", task_ids)
            .order("created_at")
            .execute()
        )
        for row in (inter_resp.data or []):
            interactions.append({
                **row,
                "task_title": task_map.get(row["task_id"], "Unknown task"),
            })

    # Gather decisions (only tasks that have task_details)
    decisions = [
        {
            "task_id": t["id"],
            "task_title": t["title"],
            "details": t.get("task_details") or {},
        }
        for t in tasks
        if t.get("task_details")
    ]

    return {"interactions": interactions, "decisions": decisions}
