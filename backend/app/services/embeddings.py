"""Embedding helpers for project memory vector search."""
from __future__ import annotations

import logging

from openai import AsyncOpenAI

from app.config import get_settings

logger = logging.getLogger(__name__)

_EMBED_MODEL = "text-embedding-3-small"  # 1536 dims, matches migration


def _build_text_for_embedding(title: str | None, content: str | None, summary: str | None = None) -> str:
    parts = [p for p in (title, summary, content) if p]
    return "\n".join(parts)[:8000]  # cap input length


async def generate_embedding(text: str) -> list[float] | None:
    """Generate a single embedding vector. Returns None on failure."""
    if not text or not text.strip():
        return None
    settings = get_settings()
    if not settings.openai_api_key:
        return None
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    try:
        resp = await client.embeddings.create(model=_EMBED_MODEL, input=text)
        return resp.data[0].embedding
    except Exception as exc:
        logger.warning("Embedding generation failed: %s", exc)
        return None


async def embed_memory_chunk(title: str | None, content: str | None, summary: str | None = None) -> list[float] | None:
    text = _build_text_for_embedding(title, content, summary)
    return await generate_embedding(text)
