-- Lost N Found — Supabase persistence schema
--
-- The app keeps its dataset in memory and persists one JSON snapshot.
-- With Supabase configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) that
-- snapshot lives in this table; otherwise it stays in data/db.json.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.app_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- The Node server talks to this table with the service role key, which
-- bypasses row level security. RLS is enabled so the anon/public key cannot
-- read or write the snapshot; do not add a public policy here.
alter table public.app_state enable row level security;

revoke all on table public.app_state from anon, authenticated;

-- Seed the row the store expects (DB_STATE_KEY defaults to 'db').
insert into public.app_state (id, data)
values ('db', '{}'::jsonb)
on conflict (id) do nothing;
