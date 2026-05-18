-- Project memory vector search (pgvector)
-- Adds embedding column to memory_chunks + similarity-search RPC.

create extension if not exists vector;

alter table public.memory_chunks
    add column if not exists embedding vector(1536);

create index if not exists memory_chunks_embedding_idx
    on public.memory_chunks
    using ivfflat (embedding vector_cosine_ops)
    with (lists = 100);

-- Similarity search RPC: returns top-K relevant chunks for a project.
create or replace function public.match_memory_chunks(
    p_project_id uuid,
    p_query_embedding vector(1536),
    p_match_threshold float default 0.5,
    p_match_count int default 8
)
returns table (
    id uuid,
    source_type text,
    source_id text,
    title text,
    content text,
    summary text,
    tags jsonb,
    importance int,
    similarity float
)
language sql
stable
as $$
    select
        mc.id,
        mc.source_type,
        mc.source_id,
        mc.title,
        mc.content,
        mc.summary,
        mc.tags,
        mc.importance,
        1 - (mc.embedding <=> p_query_embedding) as similarity
    from public.memory_chunks mc
    where mc.project_id = p_project_id
      and mc.embedding is not null
      and 1 - (mc.embedding <=> p_query_embedding) > p_match_threshold
    order by mc.embedding <=> p_query_embedding
    limit p_match_count;
$$;

grant execute on function public.match_memory_chunks(uuid, vector, float, int) to service_role;
