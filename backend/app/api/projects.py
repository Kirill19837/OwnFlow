from __future__ import annotations

from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends, File, Form, UploadFile
from fastapi.responses import StreamingResponse
from app.models import ProjectCreate
from app.db import get_supabase
from app.services.ai_orchestrator import breakdown_project, plan_sprint_one, generate_next_sprint
from app.services.sprint_planner import plan_and_persist
from app.services.assignment_engine import auto_assign
from app.config import get_settings
from app.auth_deps import current_user_id
from app.assistants import (
    ProjectAssistBody,
    generate_project_creation_suggestion,
)
from app.api.actors import _mask_actor
from app.api.tasks import _strip_task
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


@router.post("/assist-with-documents")
async def assist_project_creation_with_documents(
    files: list[UploadFile] = File(default=[]),
    request: str = Form(""),
    name: str = Form(""),
    ai_model: str = Form("gpt-4o"),
    _caller_id: str = Depends(current_user_id),
):
    """Analyse uploaded documents + description and generate project specs."""
    from app.services.document_ingestion import extract_document_text, DocumentIngestionError

    document_texts: list[str] = []
    file_errors: list[str] = []
    for upload in files:
        try:
            raw = await upload.read()
            text = extract_document_text(upload.filename or "file", upload.content_type, raw)
            document_texts.append(f"=== {upload.filename} ===\n{text[:5000]}")
        except DocumentIngestionError as exc:
            file_errors.append(f"{upload.filename}: {exc}")

    if file_errors and not document_texts and not request.strip():
        raise HTTPException(400, f"Could not read uploaded files — {'; '.join(file_errors)}. Add a text description or upload supported file types.")

    body = ProjectAssistBody(
        name=name,
        request=request,
        ai_model=ai_model,
        document_texts=document_texts,
    )
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
        _LOG_LEVEL_MAP = {"debug": 0, "info": 1, "warning": 2, "error": 3}

        def _persist_log(msg: str, level: str = "info") -> None:
            try:
                db.table("ai_logs").insert({
                    "id": str(uuid.uuid4()),
                    "project_id": project_id,
                    "phase": 0,
                    "message": msg,
                    "level": _LOG_LEVEL_MAP.get(level, 1),
                }).execute()
            except Exception:
                pass

        def _log(msg: str, level: str = "info") -> str:
            _persist_log(msg, level)
            return f"data: {json.dumps({'type': 'log', 'message': msg})}\n\n"

        try:
            yield _log(f"🔍 Analyzing project: {project['name']!r}")
            yield _log(f"⚙️  Calling {ai_model} to generate roadmap + Sprint 1 breakdown…")

            # Load actors so the AI can assign actor_role per task
            actors_resp = db.table("actors").select("name,role,type").eq("project_id", project_id).execute()
            project_actors = actors_resp.data or []

            sprint1_tasks, roadmap = await plan_sprint_one(project["prompt"], model=ai_model, project_id=project_id, actors=project_actors)
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
        "tasks": [
            {
                **_strip_task(t),
                "assignments": [
                    {
                        **a,
                        "actors": _mask_actor(a["actors"]) if isinstance(a.get("actors"), dict) else a.get("actors"),
                    } if isinstance(a, dict) else a
                    for a in (t.get("assignments") or [])
                ] if isinstance(t.get("assignments"), list) else t.get("assignments"),
            }
            for t in tasks
        ],
        "actors": [_mask_actor(a) for a in (actors.data or [])],
    }


@router.get("/{project_id}/agent-runtime")
def get_project_agent_runtime(project_id: str):
    """Return non-secret runtime status for built-in agents used by this project."""
    db = get_supabase()
    settings = get_settings()

    project_resp = (
        db.table("projects")
        .select("id,team_id")
        .eq("id", project_id)
        .single()
        .execute()
    )
    project = project_resp.data
    if not project:
        raise HTTPException(404, "Project not found")

    company_id = None
    if project.get("team_id"):
        team_resp = (
            db.table("teams")
            .select("company_id")
            .eq("id", project["team_id"])
            .single()
            .execute()
        )
        company_id = (team_resp.data or {}).get("company_id")

    company = None
    if company_id:
        company_resp = (
            db.table("companies")
            .select("openai_api_key,anthropic_api_key")
            .eq("id", company_id)
            .single()
            .execute()
        )
        company = company_resp.data or {}

    has_company_openai = bool(company and company.get("openai_api_key"))
    has_company_anthropic = bool(company and company.get("anthropic_api_key"))
    has_server_openai = bool(settings.openai_api_key)
    has_server_anthropic = bool(settings.anthropic_api_key)

    def _source(has_company_key: bool, has_server_key: bool) -> str:
        if has_company_key:
            return "company"
        if has_server_key:
            return "server"
        return "none"

    return {
        "builtin_agent_image": settings.builtin_agent_image,
        "image_source": "server_env",
        "openai_key": {
            "source": _source(has_company_openai, has_server_openai),
            "company_available": has_company_openai,
            "server_available": has_server_openai,
        },
        "anthropic_key": {
            "source": _source(has_company_anthropic, has_server_anthropic),
            "company_available": has_company_anthropic,
            "server_available": has_server_anthropic,
        },
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


@router.get("/dashboard/executor-state")
def dashboard_executor_state(owner_id: str = "", team_id: str = ""):
    """Return currently running task-executor state for dashboard monitoring."""
    db = get_supabase()

    projects_q = db.table("projects").select("id,name")
    if team_id:
        projects_q = projects_q.eq("team_id", team_id)
    elif owner_id:
        projects_q = projects_q.eq("owner_id", owner_id)
    else:
        return {
            "running_count": 0,
            "projects_with_running": 0,
            "running": [],
            "recent_failures": [],
        }

    projects = projects_q.execute().data or []
    if not projects:
        return {
            "running_count": 0,
            "projects_with_running": 0,
            "running": [],
            "recent_failures": [],
        }

    project_map = {p["id"]: p.get("name") or "Untitled project" for p in projects if p.get("id")}
    project_ids = list(project_map.keys())
    if not project_ids:
        return {
            "running_count": 0,
            "projects_with_running": 0,
            "running": [],
            "recent_failures": [],
        }

    task_resp = (
        db.table("tasks")
        .select("id,title,project_id,status,priority,agent_dispatched_at,created_at")
        .in_("project_id", project_ids)
        .eq("status", "in_progress")
        .order("agent_dispatched_at", desc=True)
        .execute()
    )
    tasks = task_resp.data or []
    task_ids = [t["id"] for t in tasks if t.get("id")]
    assignment_actor: dict[str, dict] = {}
    if task_ids:
        assignments = (
            db.table("assignments")
            .select("task_id, actors(name,type)")
            .in_("task_id", task_ids)
            .execute()
            .data
            or []
        )
        for a in assignments:
            task_id = a.get("task_id")
            if not task_id or task_id in assignment_actor:
                continue
            actor = a.get("actors")
            if isinstance(actor, dict):
                assignment_actor[task_id] = {
                    "name": actor.get("name") or "Unassigned",
                    "type": actor.get("type") or "unknown",
                }

    running = []
    for t in tasks:
        actor = assignment_actor.get(t["id"], {"name": "Unassigned", "type": "unknown"})
        running.append({
            "task_id": t["id"],
            "task_title": t.get("title") or "Untitled task",
            "project_id": t.get("project_id"),
            "project_name": project_map.get(t.get("project_id"), "Unknown project"),
            "status": t.get("status"),
            "priority": t.get("priority"),
            "updated_at": t.get("agent_dispatched_at") or t.get("created_at"),
            "actor_name": actor.get("name"),
            "actor_type": actor.get("type"),
        })

    error_logs = (
        db.table("ai_logs")
        .select("project_id,phase,message,created_at")
        .in_("project_id", project_ids)
        .eq("level", 3)
        .in_("phase", [3, 2, 1])
        .order("created_at", desc=True)
        .limit(12)
        .execute()
        .data
        or []
    )

    recent_failures = [
        {
            "project_id": row.get("project_id"),
            "project_name": project_map.get(row.get("project_id"), "Unknown project"),
            "phase": row.get("phase"),
            "message": row.get("message") or "Executor error",
            "created_at": row.get("created_at"),
        }
        for row in error_logs
    ]

    return {
        "running_count": len(running),
        "projects_with_running": len({r["project_id"] for r in running if r.get("project_id")}),
        "running": running,
        "recent_failures": recent_failures,
    }


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
    next_actors_resp = db.table("actors").select("name,role,type").eq("project_id", project_id).execute()
    tasks = await generate_next_sprint(project_id, next_sprint_num, model=ai_model, actors=next_actors_resp.data or [])
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

    # Find ready tasks with assigned AI actors — exclude executed or completed tasks
    tasks_resp = (
        db.table("tasks")
        .select("id, title, assignments(actor_id, actors(type))")
        .in_("sprint_id", sprint_ids)
        .eq("is_ready", True)
        .not_.in_("status", ["review", "done"])
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
            if actor.get("type") == "ai" or actor.get("webhook_url"):
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
