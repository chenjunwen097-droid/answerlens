-- AnswerLens v2 schema (Supabase/Postgres).
-- v2.0 can run on localStorage; these tables are the server-side source of
-- truth once auth is enabled.

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  product text,
  created_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  title text not null,
  status text not null default 'running'
    check (status in ('running', 'reviewing', 'complete', 'failed')),
  current_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.report_versions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  version int not null,
  score int,
  metrics jsonb not null default '{}'::jsonb,
  positioning jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  model_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (report_id, version)
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  report_version_id uuid not null references public.report_versions(id) on delete cascade,
  idx int not null,
  text text not null,
  score int,
  unique (report_version_id, idx)
);

create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  report_version_id uuid not null references public.report_versions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  provider text not null,
  model text not null,
  text text not null,
  latency_ms int,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.judgments (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references public.answers(id) on delete cascade,
  dimensions jsonb not null,
  reasons jsonb not null default '{}'::jsonb,
  applicable jsonb not null default '{}'::jsonb,
  judge_model text not null,
  degraded boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.reports(id) on delete cascade,
  status text not null,
  stage text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  cost jsonb not null default '{}'::jsonb,
  error text
);

create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  scope text not null check (scope in ('conversation', 'report')),
  report_id uuid references public.reports(id) on delete cascade,
  agent_session_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  text text not null,
  blocks jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.runs(id) on delete cascade,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.quota_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  date date not null,
  delta int not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists reports_user_updated_idx
  on public.reports (user_id, updated_at desc);
create index if not exists messages_thread_created_idx
  on public.messages (thread_id, created_at);
create index if not exists answers_question_idx on public.answers (question_id);
create index if not exists quota_user_date_idx on public.quota_events (user_id, date);

alter table public.profiles enable row level security;
alter table public.brands enable row level security;
alter table public.reports enable row level security;
alter table public.report_versions enable row level security;
alter table public.questions enable row level security;
alter table public.answers enable row level security;
alter table public.judgments enable row level security;
alter table public.runs enable row level security;
alter table public.threads enable row level security;
alter table public.messages enable row level security;
alter table public.artifacts enable row level security;
alter table public.quota_events enable row level security;

-- v2.1 will add per-user policies. Until auth ships, all writes go through the
-- service role on the server.
