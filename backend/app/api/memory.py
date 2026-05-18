"""Project Memory API — memory chunks, decisions, context packs, GitHub sync."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException

from app.db import get_supabase
from app.models import (
    DecisionCreate,
    DecisionUpdate,
    MemoryChunkCreate,
    MemoryChunkUpdate,
)

router = APIRouter()


# ── Memory Chunks ─────────────────────────────────────────────────────────────

@router.get("/{project_id}/memory")
def list_memory_chunks(project_id: str, source_type: str = ""):
    db = get_supabase()
    q = (
        db.table("memory_chunks")
        .select("*")
        .eq("project_id", project_id)
        .order("importance", desc=True)
        .order("created_at")
    )
    if source_type:
        q = q.eq("source_type", source_type)
    return q.execute().data or []


@router.post("/{project_id}/memory", status_code=201)
def create_memory_chunk(project_id: str, body: MemoryChunkCreate):
    db = get_supabase()
    row = {
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        "source_type": body.source_type,
        "source_id": body.source_id,
        "title": body.title,
        "content": body.content,
        "summary": body.summary,
        "tags": body.tags,
        "importance": body.importance,
    }
    result = db.table("memory_chunks").insert(row).execute()
    return result.data[0]


@router.patch("/{project_id}/memory/{chunk_id}")
def update_memory_chunk(project_id: str, chunk_id: str, body: MemoryChunkUpdate):
    db = get_supabase()
    chunk = (
        db.table("memory_chunks")
        .select("id")
        .eq("id", chunk_id)
        .eq("project_id", project_id)
        .execute()
    )
    if not chunk.data:
        raise HTTPException(404, "Memory chunk not found")
    update = body.model_dump(exclude_none=True)
    if not update:
        raise HTTPException(400, "No fields to update")
    result = (
        db.table("memory_chunks").update(update).eq("id", chunk_id).execute()
    )
    return result.data[0]


@router.delete("/{project_id}/memory/{chunk_id}", status_code=204)
def delete_memory_chunk(project_id: str, chunk_id: str):
    db = get_supabase()
    chunk = (
        db.table("memory_chunks")
        .select("id")
        .eq("id", chunk_id)
        .eq("project_id", project_id)
        .execute()
    )
    if not chunk.data:
        raise HTTPException(404, "Memory chunk not found")
    db.table("memory_chunks").delete().eq("id", chunk_id).execute()


# ── Decisions ─────────────────────────────────────────────────────────────────

@router.get("/{project_id}/decisions")
def list_decisions(project_id: str):
    db = get_supabase()
    return (
        db.table("decisions")
        .select("*")
        .eq("project_id", project_id)
        .order("created_at", desc=True)
        .execute()
        .data
        or []
    )


@router.post("/{project_id}/decisions", status_code=201)
def create_decision(project_id: str, body: DecisionCreate):
    db = get_supabase()
    row = {
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        **body.model_dump(),
    }
    result = db.table("decisions").insert(row).execute()
    return result.data[0]


@router.patch("/{project_id}/decisions/{decision_id}")
def update_decision(project_id: str, decision_id: str, body: DecisionUpdate):
    db = get_supabase()
    d = (
        db.table("decisions")
        .select("id")
        .eq("id", decision_id)
        .eq("project_id", project_id)
        .execute()
    )
    if not d.data:
        raise HTTPException(404, "Decision not found")
    update = body.model_dump(exclude_none=True)
    if not update:
        raise HTTPException(400, "No fields to update")
    result = db.table("decisions").update(update).eq("id", decision_id).execute()
    return result.data[0]


@router.delete("/{project_id}/decisions/{decision_id}", status_code=204)
def delete_decision(project_id: str, decision_id: str):
    db = get_supabase()
    d = (
        db.table("decisions")
        .select("id")
        .eq("id", decision_id)
        .eq("project_id", project_id)
        .execute()
    )
    if not d.data:
        raise HTTPException(404, "Decision not found")
    db.table("decisions").delete().eq("id", decision_id).execute()


# ── Context Pack ──────────────────────────────────────────────────────────────

@router.post("/{project_id}/context-pack/{task_id}")
def build_context_pack(project_id: str, task_id: str):
    """Build and persist a context pack for a specific task."""
    db = get_supabase()

    project = (
        db.table("projects")
        .select("id,name,prompt")
        .eq("id", project_id)
        .single()
        .execute()
    )
    if not project.data:
        raise HTTPException(404, "Project not found")

    task = (
        db.table("tasks")
        .select("id,title,description,type,priority")
        .eq("id", task_id)
        .single()
        .execute()
    )
    if not task.data:
        raise HTTPException(404, "Task not found")

    chunks = (
        db.table("memory_chunks")
        .select("*")
        .eq("project_id", project_id)
        .order("importance", desc=True)
        .limit(20)
        .execute()
        .data
        or []
    )
    active_decisions = (
        db.table("decisions")
        .select("*")
        .eq("project_id", project_id)
        .eq("status", "active")
        .execute()
        .data
        or []
    )

    parts: list[str] = [
        f"# Project: {project.data['name']}",
        f"## Goal\n{project.data.get('prompt', '')}",
        f"\n## Task\n**{task.data['title']}**\n{task.data.get('description', '')}",
    ]

    if chunks:
        parts.append("\n## Project Memory")
        for c in chunks:
            excerpt = c.get("summary") or c["content"][:500]
            parts.append(f"\n### [{c['source_type']}] {c['title']}\n{excerpt}")

    if active_decisions:
        parts.append("\n## Active Decisions")
        for dec in active_decisions:
            parts.append(
                f"\n### {dec['title']}\n"
                f"**Decision:** {dec['decision']}\n"
                f"**Reason:** {dec.get('reason') or 'N/A'}"
            )

    content = "\n".join(parts)
    token_count = len(content) // 4  # rough 1 token ≈ 4 chars estimate
    included_ids = [c["id"] for c in chunks]

    row = {
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        "task_id": task_id,
        "content": content,
        "included_chunk_ids": included_ids,
        "token_count": token_count,
    }
    result = db.table("context_packs").insert(row).execute()
    return result.data[0]


@router.get("/{project_id}/context-pack/{task_id}/latest")
def get_latest_context_pack(project_id: str, task_id: str):
    """Return the most recent context pack for a task."""
    db = get_supabase()
    result = (
        db.table("context_packs")
        .select("*")
        .eq("project_id", project_id)
        .eq("task_id", task_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    if not result.data:
        raise HTTPException(404, "No context pack found for this task")
    return result.data[0]


# ── Task Memory Backfill ──────────────────────────────────────────────────────

@router.post("/{project_id}/memory/sync-tasks")
def sync_tasks_memory(project_id: str):
    """Backfill memory_chunks from existing tasks with non-empty task_details."""
    from datetime import datetime, timezone
    db = get_supabase()
    tasks = (
        db.table("tasks")
        .select("id,title,task_details")
        .eq("project_id", project_id)
        .execute()
        .data
        or []
    )
    created = 0
    updated = 0
    skipped = 0
    for t in tasks:
        details = t.get("task_details") or {}
        if not isinstance(details, dict) or not details:
            skipped += 1
            continue
        task_id = t["id"]
        title = t.get("title") or "Untitled task"
        details_lines = "\n".join(f"- {k}: {v}" for k, v in details.items())
        content = f"Task: {title}\n\nRefinement decisions:\n{details_lines}"
        summary = f"Refined task '{title}' with {len(details)} captured decisions."
        existing = (
            db.table("memory_chunks")
            .select("id")
            .eq("project_id", project_id)
            .eq("source_type", "business-rules")
            .eq("source_id", task_id)
            .execute()
        )
        if existing.data:
            db.table("memory_chunks").update({
                "title": f"Task refinement: {title}",
                "content": content,
                "summary": summary,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", existing.data[0]["id"]).execute()
            updated += 1
        else:
            db.table("memory_chunks").insert({
                "id": str(uuid.uuid4()),
                "project_id": project_id,
                "source_type": "business-rules",
                "source_id": task_id,
                "title": f"Task refinement: {title}",
                "content": content,
                "summary": summary,
                "tags": ["task-refinement"],
                "importance": 6,
            }).execute()
            created += 1
    return {"created": created, "updated": updated, "skipped": skipped, "total_tasks": len(tasks)}


# ── GitHub Memory Sync (MVP2) ─────────────────────────────────────────────────

@router.post("/{project_id}/memory/sync-github")
async def sync_github_memory(project_id: str):
    """Sync recent merged PRs and commits as memory chunks (MVP2)."""
    from app.services import github_service as gh

    db = get_supabase()
    conn = await gh.get_connection_for_project(project_id)
    if not conn:
        raise HTTPException(400, "No GitHub connection configured for this project")

    token = conn["token"]
    owner = conn["owner"]
    repo = conn["repo"]

    prs = await gh.list_merged_prs(token, owner, repo, limit=20)
    created = 0
    for pr in prs:
        existing = (
            db.table("memory_chunks")
            .select("id")
            .eq("project_id", project_id)
            .eq("source_type", "pull_request")
            .eq("source_id", str(pr["number"]))
            .execute()
        )
        if existing.data:
            continue
        row = {
            "id": str(uuid.uuid4()),
            "project_id": project_id,
            "source_type": "pull_request",
            "source_id": str(pr["number"]),
            "title": f"PR #{pr['number']}: {pr['title']}",
            "content": pr.get("body") or f"Merged PR: {pr['title']}",
            "summary": (
                f"PR #{pr['number']} merged by {pr.get('merged_by') or 'unknown'}: {pr['title']}"
            ),
            "tags": ["github", "pr"],
            "importance": 6,
        }
        db.table("memory_chunks").insert(row).execute()
        created += 1

    return {"synced_prs": created}
