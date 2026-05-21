"""File storage service using Supabase Storage."""
from __future__ import annotations

import uuid
from app.db import get_supabase

STORAGE_BUCKET = "deliverables"
SIGNED_URL_EXPIRES_IN = 3600  # seconds (1 hour)


def _ensure_bucket_exists() -> None:
    """Ensure the deliverables bucket exists in Supabase Storage."""
    try:
        db = get_supabase()
        db.storage.from_(STORAGE_BUCKET).list()
    except Exception:
        try:
            db = get_supabase()
            # Fix 1: bucket is private (public: False) — files are only accessible
            # via signed URLs, not guessable public paths.
            db.storage.create_bucket(STORAGE_BUCKET, options={"public": False})
        except Exception:
            pass


async def upload_file(
        task_id: str, file_path: str, file_content: str
) -> str:
    """
    Upload a file to Supabase Storage.

    Args:
        task_id: The task ID (used for organising files)
        file_path: Original file path (e.g., "src/main.py")
        file_content: File content as string

    Returns:
        Signed URL to the uploaded file (expires in SIGNED_URL_EXPIRES_IN seconds)
    """
    _ensure_bucket_exists()

    db = get_supabase()

    # Fix 2 (partial): flatten the path to tasks/{task_id}/{uuid}_{filename} so
    # delete_task_files() can find every upload with a single non-recursive list().
    # The uuid prefix still prevents collisions between concurrent uploads of the
    # same filename.
    file_name = file_path.split("/")[-1]
    unique_id = str(uuid.uuid4())[:8]
    storage_path = f"tasks/{task_id}/{unique_id}_{file_name}"

    try:
        db.storage.from_(STORAGE_BUCKET).upload(
            storage_path,
            file_content.encode() if isinstance(file_content, str) else file_content,
        )

        # Fix 1 (cont.): return a time-limited signed URL instead of a permanent
        # public URL.  Callers that need a longer-lived link should increase
        # SIGNED_URL_EXPIRES_IN or re-generate the URL on demand.
        signed = db.storage.from_(STORAGE_BUCKET).create_signed_url(
            storage_path, SIGNED_URL_EXPIRES_IN
        )
        return signed["signedURL"]
    except Exception as exc:
        raise RuntimeError(f"Failed to upload file to storage: {exc}") from exc


async def get_signed_url(storage_path: str, expires_in: int = SIGNED_URL_EXPIRES_IN) -> str:
    """
    Generate a fresh signed URL for an already-uploaded file.

    Useful when the original signed URL has expired and the caller holds the
    storage path (e.g. retrieved from the database).
    """
    try:
        db = get_supabase()
        signed = db.storage.from_(STORAGE_BUCKET).create_signed_url(storage_path, expires_in)
        return signed["signedURL"]
    except Exception as exc:
        raise RuntimeError(f"Failed to create signed URL: {exc}") from exc


async def delete_task_files(task_id: str) -> None:
    """Delete all files for a task from storage."""
    try:
        db = get_supabase()
        prefix = f"tasks/{task_id}/"
        # Fix 2: files now live directly under tasks/{task_id}/ (no uuid sub-folder),
        # so a single list() call finds everything and the paths don't need a prefix
        # re-appended — Supabase list() returns names relative to the prefix, so we
        # reconstruct full paths before passing them to remove().
        files = db.storage.from_(STORAGE_BUCKET).list(prefix)
        if files:
            full_paths = [prefix + f["name"] for f in files]
            db.storage.from_(STORAGE_BUCKET).remove(full_paths)
    except Exception:
        pass
