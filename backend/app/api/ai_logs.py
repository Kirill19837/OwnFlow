from __future__ import annotations

from fastapi import APIRouter
from app.db import get_supabase

router = APIRouter()


@router.delete("/dashboard/ai-logs", status_code=204)
def clear_ai_logs(owner_id: str = "", team_id: str = "", project_id: str = ""):
    """Delete all AI logs visible to the caller (scoped to team, owner, or project)."""
    db = get_supabase()

    if project_id:
        project_ids = [project_id]
    else:
        projects_q = db.table("projects").select("id")
        if team_id:
            projects_q = projects_q.eq("team_id", team_id)
        elif owner_id:
            projects_q = projects_q.eq("owner_id", owner_id)
        else:
            return
        projects = projects_q.execute().data or []
        project_ids = [p["id"] for p in projects if p.get("id")]

    if not project_ids:
        return

    db.table("ai_logs").delete().in_("project_id", project_ids).execute()


@router.get("/dashboard/ai-logs")
def dashboard_ai_logs(
    owner_id: str = "",
    team_id: str = "",
    project_id: str = "",
    level: int = -1,
    phase: int = -1,
    limit: int = 100,
    offset: int = 0,
):
    """Return paginated AI logs for all projects visible to the caller."""
    db = get_supabase()

    if project_id:
        project_ids = [project_id]
    else:
        projects_q = db.table("projects").select("id,name")
        if team_id:
            projects_q = projects_q.eq("team_id", team_id)
        elif owner_id:
            projects_q = projects_q.eq("owner_id", owner_id)
        else:
            return {"logs": [], "total": 0}
        projects = projects_q.execute().data or []
        if not projects:
            return {"logs": [], "total": 0}
        project_map = {p["id"]: p.get("name") or "Untitled" for p in projects if p.get("id")}
        project_ids = list(project_map.keys())

    if not project_id:
        pass  # project_map already built
    else:
        proj_resp = db.table("projects").select("id,name").eq("id", project_id).single().execute()
        project_map = {project_id: (proj_resp.data or {}).get("name") or "Untitled"}

    logs_q = (
        db.table("ai_logs")
        .select("id,project_id,task_id,phase,level,message,created_at")
        .in_("project_id", project_ids)
        .order("created_at", desc=True)
        .limit(limit)
        .offset(offset)
    )
    if level >= 0:
        logs_q = logs_q.eq("level", level)
    if phase >= 0:
        logs_q = logs_q.eq("phase", phase)

    logs = logs_q.execute().data or []

    task_ids = list({r["task_id"] for r in logs if r.get("task_id")})
    task_title_map: dict[str, str] = {}
    if task_ids:
        tasks_resp = db.table("tasks").select("id,title").in_("id", task_ids).execute()
        for t in (tasks_resp.data or []):
            task_title_map[t["id"]] = t.get("title") or "Untitled task"

    rows = []
    for r in logs:
        rows.append({
            "id": r["id"],
            "project_id": r.get("project_id"),
            "project_name": project_map.get(r.get("project_id"), "Unknown"),
            "task_id": r.get("task_id"),
            "task_title": task_title_map.get(r.get("task_id"), None) if r.get("task_id") else None,
            "phase": r.get("phase"),
            "level": r.get("level"),
            "message": r.get("message"),
            "created_at": r.get("created_at"),
        })

    return {"logs": rows, "total": len(rows)}
