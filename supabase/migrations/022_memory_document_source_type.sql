-- Allow uploaded document chunks in project memory.

alter table public.memory_chunks
  drop constraint if exists memory_chunks_source_type_check;

alter table public.memory_chunks
  add constraint memory_chunks_source_type_check
  check (
    source_type in (
      'product',
      'architecture',
      'coding-standards',
      'business-rules',
      'code_file',
      'pull_request',
      'commit',
      'document'
    )
  );
