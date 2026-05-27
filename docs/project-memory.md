# Project Memory and Document Indexing

This document describes how OwnFlow stores project memory, how document upload works, and how content is indexed for vector retrieval.

## Overview

OwnFlow project memory is built around `memory_chunks` with optional embeddings (`vector(1536)`).

Sources include:
- Product, architecture, coding standards, and business rules chunks
- GitHub-derived chunks (PRs, commits, code files)
- Uploaded documents (`source_type = document`)

Uploaded files are parsed, split into chunks, embedded with OpenAI `text-embedding-3-small`, and stored in `memory_chunks`.

## API Endpoints

All endpoints below require a valid Bearer token and project access:
- project owner, or
- member of the project's team.

### List memory

`GET /projects/{project_id}/memory`

Optional query params:
- `source_type` (string)

### Create memory chunk manually

`POST /projects/{project_id}/memory`

Body (JSON):

```json
{
  "source_type": "product",
  "title": "System constraints",
  "content": "...",
  "summary": "...",
  "tags": ["backend"],
  "importance": 6
}
```

### Upload documents and index into vector memory

`POST /projects/{project_id}/memory/upload-documents`

Content type: `multipart/form-data`

Fields:
- `files` (one or multiple files)
- `importance` (optional int 1-10, default `6`)

Response:

```json
{
  "uploaded_files": 2,
  "indexed_files": 2,
  "created_chunks": 9,
  "results": [
    { "filename": "Spec.pdf", "status": "indexed", "chunks": 6 },
    { "filename": "notes.md", "status": "indexed", "chunks": 3 }
  ]
}
```

If none of the provided files can be indexed, API returns `400` with per-file reasons.

### Backfill

- `POST /projects/{project_id}/memory/sync-tasks`
- `POST /projects/{project_id}/memory/sync-embeddings`
- `POST /projects/{project_id}/memory/sync-github`

## Quick Start (curl)

Set these first:

```bash
export API_BASE="http://localhost:8000"
export PROJECT_ID="<project-uuid>"
```

Set auth token:

```bash
export ACCESS_TOKEN="<supabase-jwt>"
export AUTH_HEADER="Authorization: Bearer $ACCESS_TOKEN"
```

### Upload one or more documents

```bash
curl -X POST "$API_BASE/projects/$PROJECT_ID/memory/upload-documents?importance=7" \
  -F "files=@./docs/Spec.pdf" \
  -F "files=@./docs/notes.md"
```

Authenticated variant:

```bash
curl -X POST "$API_BASE/projects/$PROJECT_ID/memory/upload-documents?importance=7" \
  -H "$AUTH_HEADER" \
  -F "files=@./docs/Spec.pdf" \
  -F "files=@./docs/notes.md"
```

### List only uploaded document chunks

```bash
curl "$API_BASE/projects/$PROJECT_ID/memory?source_type=document"
```

Authenticated variant:

```bash
curl -H "$AUTH_HEADER" "$API_BASE/projects/$PROJECT_ID/memory?source_type=document"
```

### Trigger embedding backfill (for older rows missing vectors)

```bash
curl -X POST "$API_BASE/projects/$PROJECT_ID/memory/sync-embeddings"
```

Authenticated variant:

```bash
curl -X POST -H "$AUTH_HEADER" "$API_BASE/projects/$PROJECT_ID/memory/sync-embeddings"
```

### Trigger task-details backfill into memory

```bash
curl -X POST "$API_BASE/projects/$PROJECT_ID/memory/sync-tasks"
```

Authenticated variant:

```bash
curl -X POST -H "$AUTH_HEADER" "$API_BASE/projects/$PROJECT_ID/memory/sync-tasks"
```

## Supported File Types

Current parser support:
- PDF (`.pdf`)
- DOCX (`.docx`)
- Text and text-like files (for example `.txt`, `.md`, `.json`, `.yaml`, `.csv`, code files)

Constraints:
- Max file size: 10 MB per file
- Empty or unreadable files are skipped with a reason

## Ingestion Pipeline

1. Receive uploaded file(s)
2. Extract normalized text
3. Split text into overlapping chunks
4. Generate embedding per chunk
5. Insert chunk rows into `memory_chunks`:
   - `source_type = document`
   - `source_id = <doc_uuid>:<part_index>`
   - `title = filename or filename (part i/n)`
   - `tags` includes `document-upload` and `filename:<name>`

## Vector Search

`memory_chunks.embedding` uses `vector(1536)`.

RPC function:
- `match_memory_chunks(p_project_id, p_query_embedding, p_match_threshold, p_match_count)`

This returns top matching chunks for context assembly.

## Frontend UX

Project Memory page includes:
- Manual chunk creation/edit/delete
- `Upload docs` button in Memory tab
- Type filter includes `Documents`

On upload success, the page refreshes chunk list and shows indexed file/chunk counts.

## Required Migrations

Ensure these are applied:
- `019_project_memory.sql`
- `020_memory_embeddings.sql`
- `022_memory_document_source_type.sql`

`022` extends the `memory_chunks.source_type` check constraint to include `document`.

## Operational Notes

- Install backend dependency `pypdf` for PDF parsing.
- PDF parser import is lazy; backend can still boot without `pypdf`, but PDF uploads will fail until installed.
- Embeddings require a configured OpenAI API key.