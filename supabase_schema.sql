-- Lost N Found — Supabase persistence schema
--
-- One table per collection, one row per record. The Node server talks to these
-- tables with the service role key, which bypasses row level security, so RLS is
-- on and nothing is granted to anon/authenticated.
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL -> New query).
-- The app then needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set.

create table if not exists public.lnf_users (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.lnf_listings (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.lnf_saved (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.lnf_matches (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.lnf_conversations (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.lnf_messages (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.lnf_notifications (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.lnf_reports (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.lnf_passes (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.lnf_meta (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.lnf_users enable row level security;
alter table public.lnf_listings enable row level security;
alter table public.lnf_saved enable row level security;
alter table public.lnf_matches enable row level security;
alter table public.lnf_conversations enable row level security;
alter table public.lnf_messages enable row level security;
alter table public.lnf_notifications enable row level security;
alter table public.lnf_reports enable row level security;
alter table public.lnf_passes enable row level security;
alter table public.lnf_meta enable row level security;

revoke all on table public.lnf_users from anon, authenticated;
revoke all on table public.lnf_listings from anon, authenticated;
revoke all on table public.lnf_saved from anon, authenticated;
revoke all on table public.lnf_matches from anon, authenticated;
revoke all on table public.lnf_conversations from anon, authenticated;
revoke all on table public.lnf_messages from anon, authenticated;
revoke all on table public.lnf_notifications from anon, authenticated;
revoke all on table public.lnf_reports from anon, authenticated;
revoke all on table public.lnf_passes from anon, authenticated;
revoke all on table public.lnf_meta from anon, authenticated;

-- Uploaded photos live in this public-read bucket so listings keep their images
-- across redeploys. Writes use the service role key, so no insert policy is needed.
insert into storage.buckets (id, name, public)
values ('lnf-photos', 'lnf-photos', true)
on conflict (id) do update set public = true;

-- Older deployments kept the whole dataset in one row. It is no longer read.
drop table if exists public.app_state;
