"""Board AI assistant — streaming prompt endpoint for the project kanban board."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.db import get_supabase
from app.providers.registry import get_provider
from app.assistants import build_project_board_messages

router = APIRouter()


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

    from app.services.usage_guard import check_and_increment
    try:
        check_and_increment(project_id)
    except PermissionError as e:
        raise HTTPException(402, str(e))

    sprints_resp = db.table("sprints").select("id,sprint_number").eq("project_id", project_id).execute()
    sprint_ids = [s["id"] for s in sprints_resp.data or []]
    tasks_resp = (
        db.table("tasks")
        .select("id,title,status,type,priority,estimated_hours")
        .in_("sprint_id", sprint_ids)
        .execute()
        if sprint_ids
        else type("R", (), {"data": []})()
    )
    actors = body.get("actors") or []
    history = body.get("history") or []

    # Vector-search project memory for chunks relevant to the user's question.
    memory_chunks: list[dict] = []
    active_decisions: list[dict] = []
    try:
        from app.services.embeddings import generate_embedding
        query_embedding = await generate_embedding(user_prompt)
        if query_embedding is not None:
            rpc_resp = db.rpc(
                "match_memory_chunks",
                {
                    "p_project_id": project_id,
                    "p_query_embedding": query_embedding,
                    "p_match_threshold": 0.3,
                    "p_match_count": 8,
                },
            ).execute()
            memory_chunks = rpc_resp.data or []
        if not memory_chunks:
            memory_chunks = (
                db.table("memory_chunks")
                .select("source_type,title,content,summary,importance")
                .eq("project_id", project_id)
                .order("importance", desc=True)
                .limit(8)
                .execute()
                .data
                or []
            )
        active_decisions = (
            db.table("decisions")
            .select("title,decision,reason,status")
            .eq("project_id", project_id)
            .eq("status", "active")
            .execute()
            .data
            or []
        )
    except Exception as exc:
        import traceback
        traceback.print_exc()
        print(f"[board-assistant] memory-search failed: {exc}")

    # Always include uploaded document chunks and build filename inventory.
    document_files: list[str] = []
    try:
        doc_rows = (
            db.table("memory_chunks")
            .select("source_type,title,content,summary,importance,tags")
            .eq("project_id", project_id)
            .eq("source_type", "document")
            .order("importance", desc=True)
            .limit(6)
            .execute()
            .data
            or []
        )
        seen_titles = {c.get("title") for c in memory_chunks}
        seen_files: set[str] = set()
        for dr in doc_rows:
            tags = dr.get("tags") or []
            fname = next((t[len("filename:"):] for t in tags if t.startswith("filename:")), None)
            if fname:
                seen_files.add(fname)
            if dr.get("title") not in seen_titles:
                memory_chunks.append(dr)
                seen_titles.add(dr.get("title"))
        document_files = sorted(seen_files)
    except Exception:
        pass

    messages = build_project_board_messages(
        project=project,
        sprints=sprints_resp.data or [],
        tasks=tasks_resp.data or [],
        actors=actors,
        history=history,
        user_prompt=user_prompt,
        memory_chunks=memory_chunks,
        active_decisions=active_decisions,
        document_files=document_files,
    )

    model = "gpt-4o"
    provider = get_provider(model)

    memory_titles = [c.get("title") for c in memory_chunks if c.get("title")]
    decision_titles = [d.get("title") for d in active_decisions if d.get("title")]

    async def event_stream():
        yield (
            "data: "
            + json.dumps({
                "type": "memory_event",
                "action": "queried",
                "count": len(memory_titles),
                "titles": memory_titles[:8],
                "decisions": decision_titles[:5],
            })
            + "\n\n"
        )
        async for chunk in provider.stream(messages):
            yield f"data: {json.dumps({'content': chunk})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
