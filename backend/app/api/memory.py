"""Project Memory API — memory chunks, decisions, context packs, GitHub sync."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.auth_deps import current_user_id
from app.db import get_supabase
from app.models import (
    DecisionCreate,
    DecisionUpdate,
    MemoryChunkCreate,
    MemoryChunkUpdate,
)
from app.services.embeddings import embed_memory_chunk
from app.services.document_ingestion import (
    DocumentIngestionError,
    extract_document_text,
    split_text_into_chunks,
)

router = APIRouter()


def _require_project_member(project_id: str, caller_id: str) -> None:
    """Allow only project owner or members of the project's team."""
    db = get_supabase()
    project = (
        db.table("projects")
        .select("id,owner_id,team_id")
        .eq("id", project_id)
        .single()
        .execute()
    )
    row = project.data
    if not row:
        raise HTTPException(404, "Project not found")

    if str(row.get("owner_id") or "") == caller_id:
        return

    team_id = row.get("team_id")
    if team_id:
        member = (
            db.table("team_members")
            .select("user_id")
            .eq("team_id", team_id)
            .eq("user_id", caller_id)
            .limit(1)
            .execute()
        )
        if member.data:
            return

    raise HTTPException(403, "You do not have access to this project memory")


# ── Memory Chunks ─────────────────────────────────────────────────────────────

@router.get("/{project_id}/memory")
def list_memory_chunks(project_id: str, source_type: str = "", caller_id: str = Depends(current_user_id)):
    _require_project_member(project_id, caller_id)
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
async def create_memory_chunk(project_id: str, body: MemoryChunkCreate, caller_id: str = Depends(current_user_id)):
    _require_project_member(project_id, caller_id)
    db = get_supabase()
    embedding = await embed_memory_chunk(body.title, body.content, body.summary)
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
        "embedding": embedding,
    }
    result = db.table("memory_chunks").insert(row).execute()
    return result.data[0]


@router.patch("/{project_id}/memory/{chunk_id}")
async def update_memory_chunk(project_id: str, chunk_id: str, body: MemoryChunkUpdate, caller_id: str = Depends(current_user_id)):
    _require_project_member(project_id, caller_id)
    db = get_supabase()
    chunk = (
        db.table("memory_chunks")
        .select("id,title,content,summary")
        .eq("id", chunk_id)
        .eq("project_id", project_id)
        .execute()
    )
    if not chunk.data:
        raise HTTPException(404, "Memory chunk not found")
    update = body.model_dump(exclude_none=True)
    if not update:
        raise HTTPException(400, "No fields to update")
    # Re-embed if title/content/summary changed
    if any(k in update for k in ("title", "content", "summary")):
        current = chunk.data[0]
        update["embedding"] = await embed_memory_chunk(
            update.get("title", current.get("title")),
            update.get("content", current.get("content")),
            update.get("summary", current.get("summary")),
        )
    result = (
        db.table("memory_chunks").update(update).eq("id", chunk_id).execute()
    )
    return result.data[0]


@router.delete("/{project_id}/memory/{chunk_id}", status_code=204)
def delete_memory_chunk(project_id: str, chunk_id: str, caller_id: str = Depends(current_user_id)):
    _require_project_member(project_id, caller_id)
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
def list_decisions(project_id: str, caller_id: str = Depends(current_user_id)):
    _require_project_member(project_id, caller_id)
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
def create_decision(project_id: str, body: DecisionCreate, caller_id: str = Depends(current_user_id)):
    _require_project_member(project_id, caller_id)
    db = get_supabase()
    row = {
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        **body.model_dump(),
    }
    result = db.table("decisions").insert(row).execute()
    return result.data[0]


@router.patch("/{project_id}/decisions/{decision_id}")
def update_decision(project_id: str, decision_id: str, body: DecisionUpdate, caller_id: str = Depends(current_user_id)):
    _require_project_member(project_id, caller_id)
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
def delete_decision(project_id: str, decision_id: str, caller_id: str = Depends(current_user_id)):
    _require_project_member(project_id, caller_id)
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
def build_context_pack(project_id: str, task_id: str, caller_id: str = Depends(current_user_id)):
    """Build and persist a context pack for a specific task."""
    _require_project_member(project_id, caller_id)
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
def get_latest_context_pack(project_id: str, task_id: str, caller_id: str = Depends(current_user_id)):
    """Return the most recent context pack for a task."""
    _require_project_member(project_id, caller_id)
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
async def sync_tasks_memory(project_id: str, caller_id: str = Depends(current_user_id)):
    """Backfill memory_chunks from existing tasks with non-empty task_details."""
    _require_project_member(project_id, caller_id)
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
        chunk_title = f"Task refinement: {title}"
        embedding = await embed_memory_chunk(chunk_title, content, summary)
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
                "title": chunk_title,
                "content": content,
                "summary": summary,
                "embedding": embedding,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", existing.data[0]["id"]).execute()
            updated += 1
        else:
            db.table("memory_chunks").insert({
                "id": str(uuid.uuid4()),
                "project_id": project_id,
                "source_type": "business-rules",
                "source_id": task_id,
                "title": chunk_title,
                "content": content,
                "summary": summary,
                "tags": ["task-refinement"],
                "importance": 6,
                "embedding": embedding,
            }).execute()
            created += 1
    return {"created": created, "updated": updated, "skipped": skipped, "total_tasks": len(tasks)}


# ── Embedding Backfill ────────────────────────────────────────────────────────

@router.post("/{project_id}/memory/sync-embeddings")
async def sync_memory_embeddings(project_id: str, caller_id: str = Depends(current_user_id)):
    """Generate missing embeddings for chunks that don't have one yet."""
    _require_project_member(project_id, caller_id)
    db = get_supabase()
    chunks = (
        db.table("memory_chunks")
        .select("id,title,content,summary,embedding")
        .eq("project_id", project_id)
        .execute()
        .data
        or []
    )
    updated = 0
    skipped = 0
    failed = 0
    for c in chunks:
        if c.get("embedding"):
            skipped += 1
            continue
        emb = await embed_memory_chunk(c.get("title"), c.get("content"), c.get("summary"))
        if emb is None:
            failed += 1
            continue
        db.table("memory_chunks").update({"embedding": emb}).eq("id", c["id"]).execute()
        updated += 1
    return {"updated": updated, "skipped": skipped, "failed": failed, "total": len(chunks)}


@router.post("/{project_id}/memory/upload-documents", status_code=201)
async def upload_documents_to_memory(
    project_id: str,
    files: list[UploadFile] = File(...),
    importance: int = 6,
    caller_id: str = Depends(current_user_id),
):
    """Upload project documents, split into chunks, and index in vector memory."""
    _require_project_member(project_id, caller_id)
    if not files:
        raise HTTPException(400, "No files uploaded")
    if importance < 1 or importance > 10:
        raise HTTPException(400, "importance must be between 1 and 10")

    db = get_supabase()
    created_chunks = 0
    accepted_files = 0
    file_results: list[dict] = []

    for upload in files:
        filename = upload.filename or "uploaded-file"
        try:
            raw = await upload.read()
            extracted = extract_document_text(filename, upload.content_type, raw)
            chunks = split_text_into_chunks(extracted)
            if not chunks:
                raise DocumentIngestionError("No readable text chunks found")

            doc_id = str(uuid.uuid4())
            total_parts = len(chunks)
            for idx, chunk in enumerate(chunks, start=1):
                title = filename if total_parts == 1 else f"{filename} (part {idx}/{total_parts})"
                summary = chunk[:240] if len(chunk) > 240 else chunk
                embedding = await embed_memory_chunk(title, chunk, summary)
                db.table("memory_chunks").insert(
                    {
                        "id": str(uuid.uuid4()),
                        "project_id": project_id,
                        "source_type": "document",
                        "source_id": f"{doc_id}:{idx}",
                        "title": title,
                        "content": chunk,
                        "summary": summary,
                        "tags": ["document-upload", f"filename:{filename}"],
                        "importance": importance,
                        "embedding": embedding,
                    }
                ).execute()
            accepted_files += 1
            created_chunks += total_parts
            file_results.append(
                {
                    "filename": filename,
                    "status": "indexed",
                    "chunks": total_parts,
                }
            )
        except DocumentIngestionError as exc:
            file_results.append(
                {
                    "filename": filename,
                    "status": "skipped",
                    "reason": str(exc),
                }
            )
        except Exception as exc:
            file_results.append(
                {
                    "filename": filename,
                    "status": "failed",
                    "reason": str(exc),
                }
            )

    if accepted_files == 0:
        raise HTTPException(400, {"message": "No files were indexed", "results": file_results})

    return {
        "uploaded_files": len(files),
        "indexed_files": accepted_files,
        "created_chunks": created_chunks,
        "results": file_results,
    }


# ── GitHub Memory Sync (MVP2) ─────────────────────────────────────────────────

@router.post("/{project_id}/memory/sync-github")
async def sync_github_memory(project_id: str, caller_id: str = Depends(current_user_id)):
    """Sync recent merged PRs and commits as memory chunks (MVP2)."""
    _require_project_member(project_id, caller_id)
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
