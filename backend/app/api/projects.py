from __future__ import annotations

from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from app.models import ProjectCreate, ActorCreate
from app.db import get_supabase
from app.services.ai_orchestrator import breakdown_project
from app.services.sprint_planner import plan_and_persist
from app.services.assignment_engine import auto_assign
import uuid
import json

router = APIRouter()


@router.post("", status_code=201)
async def create_project(body: ProjectCreate, background_tasks: BackgroundTasks):
    db = get_supabase()
    project_id = str(uuid.uuid4())

    # Resolve AI model: explicit override > org default > system default
    ai_model = body.ai_model or "gpt-4o"
    if body.org_id:
        org = db.table("organizations").select("default_ai_model").eq("id", body.org_id).single().execute()
        if org.data:
            ai_model = body.ai_model or org.data["default_ai_model"]

    row = {
        "id": project_id,
        "name": body.name,
        "prompt": body.prompt,
        "owner_id": body.owner_id,
        "org_id": body.org_id,
        "status": "planning",
    }
    db.table("projects").insert(row).execute()

    if body.auto_plan:
        background_tasks.add_task(_run_planning, project_id, body.prompt, ai_model)
    return {"id": project_id, "status": "planning", "ai_model": ai_model}


async def _run_planning(project_id: str, prompt: str, ai_model: str = "gpt-4o"):
    db = get_supabase()
    try:
        tasks = await breakdown_project(prompt, model=ai_model)
        result = await plan_and_persist(project_id, tasks)

        # Auto-assign all sprints
        sprints_resp = (
            db.table("sprints").select("id").eq("project_id", project_id).execute()
        )
        for sprint in sprints_resp.data or []:
            await auto_assign(sprint["id"])

        db.table("projects").update({"status": "active"}).eq("id", project_id).execute()
    except Exception as exc:
        db.table("projects").update({"status": "error"}).eq("id", project_id).execute()
        raise


@router.get("/{project_id}/plan/stream")
async def plan_stream(project_id: str, ai_model: str = "gpt-4o"):
    db = get_supabase()
    project_resp = db.table("projects").select("name,prompt").eq("id", project_id).single().execute()
    if not project_resp.data:
        raise HTTPException(404, "Project not found")
    project = project_resp.data

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
            yield _log(f"⚙️  Calling {ai_model} to generate task breakdown…")

            task_drafts = await breakdown_project(project["prompt"], model=ai_model, project_id=project_id)
            yield _log(f"📋 Generated {len(task_drafts)} tasks")

            yield _log("📅 Organizing tasks into sprints…")
            await plan_and_persist(project_id, task_drafts)

            sprints_resp = db.table("sprints").select("id").eq("project_id", project_id).execute()
            sprint_count = len(sprints_resp.data or [])
            yield _log(f"🗂️  Created {sprint_count} sprints")

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
async def get_project(project_id: str):
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
async def list_projects(owner_id: str = "", org_id: str = ""):
    db = get_supabase()
    q = db.table("projects").select("*").order("created_at", desc=True)
    if org_id:
        q = q.eq("org_id", org_id)
    elif owner_id:
        q = q.eq("owner_id", owner_id)
    return q.execute().data or []


@router.post("/{project_id}/actors", status_code=201)
async def add_actor(project_id: str, body: ActorCreate):
    db = get_supabase()
    row = {
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        "name": body.name,
        "type": body.type,
        "model": body.model,
        "capabilities": body.capabilities,
        "avatar_url": body.avatar_url,
    }
    db.table("actors").insert(row).execute()
    return row


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str):
    db = get_supabase()
    project = db.table("projects").select("id").eq("id", project_id).single().execute()
    if not project.data:
        raise HTTPException(404, "Project not found")
    db.table("projects").delete().eq("id", project_id).execute()


@router.post("/{project_id}/regenerate", status_code=200)
async def regenerate_plan(project_id: str):
    """Wipe all sprints/tasks/assignments for a project and re-run planning via the stream endpoint."""
    db = get_supabase()
    project = db.table("projects").select("id,prompt,ai_model").eq("id", project_id).single().execute()
    if not project.data:
        raise HTTPException(404, "Project not found")

    # Delete existing sprints (cascade deletes tasks + assignments)
    db.table("sprints").delete().eq("project_id", project_id).execute()
    # Reset status back to planning
    db.table("projects").update({"status": "planning"}).eq("id", project_id).execute()
    return {"id": project_id, "status": "planning"}
