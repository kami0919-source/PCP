begin;

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  legacy_id text,
  name text not null,
  client text not null default '',
  project_type text not null default '',
  status text not null default '提案中',
  stage text not null default '需求整理',
  owner_name text not null default '',
  due_date date,
  source_text text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, legacy_id)
);

create table if not exists public.project_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  source_type text not null default 'text',
  content text not null default '',
  version integer not null default 1 check (version > 0),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.project_analyses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_id uuid references public.project_sources(id) on delete set null,
  version integer not null check (version > 0),
  provider text not null,
  model text not null,
  status text not null default 'draft' check (status in ('draft', 'reviewed', 'approved', 'rejected')),
  result jsonb not null,
  prompt_version text not null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, version)
);

create table if not exists public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  completed boolean not null default false,
  due_date date,
  assignee_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  content_type text,
  byte_size bigint not null default 0 check (byte_size >= 0),
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.reusable_materials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  legacy_id text,
  title text not null,
  category text not null default '',
  applicable text not null default '',
  summary text not null default '',
  content text not null default '',
  tags text[] not null default '{}',
  usage_count integer not null default 0 check (usage_count >= 0),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, legacy_id)
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at before update on public.projects
for each row execute procedure public.set_updated_at();

create or replace function public.is_organization_member(target uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.organization_members m where m.organization_id = target and m.user_id = auth.uid()) $$;

create or replace function public.can_edit_organization(target uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.organization_members m where m.organization_id = target and m.user_id = auth.uid() and m.role in ('admin','editor')) $$;

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_members enable row level security;
alter table public.projects enable row level security;
alter table public.project_sources enable row level security;
alter table public.project_analyses enable row level security;
alter table public.project_tasks enable row level security;
alter table public.attachments enable row level security;
alter table public.reusable_materials enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "members read organizations" on public.organizations;
drop policy if exists "users read own profile" on public.profiles;
drop policy if exists "members read memberships" on public.organization_members;
drop policy if exists "members read projects" on public.projects;
drop policy if exists "editors insert projects" on public.projects;
drop policy if exists "editors update projects" on public.projects;
drop policy if exists "editors delete projects" on public.projects;
drop policy if exists "members read project sources" on public.project_sources;
drop policy if exists "editors manage project sources" on public.project_sources;
drop policy if exists "members read analyses" on public.project_analyses;
drop policy if exists "editors manage analyses" on public.project_analyses;
drop policy if exists "members read tasks" on public.project_tasks;
drop policy if exists "editors manage tasks" on public.project_tasks;
drop policy if exists "members read attachments" on public.attachments;
drop policy if exists "editors manage attachments" on public.attachments;
drop policy if exists "members read reusable materials" on public.reusable_materials;
drop policy if exists "editors manage reusable materials" on public.reusable_materials;
drop policy if exists "admins read audit logs" on public.audit_logs;

create policy "members read organizations" on public.organizations for select using (public.is_organization_member(id));
create policy "users read own profile" on public.profiles for select using (id = auth.uid());
create policy "members read memberships" on public.organization_members for select using (public.is_organization_member(organization_id));
create policy "members read projects" on public.projects for select using (public.is_organization_member(organization_id));
create policy "editors insert projects" on public.projects for insert with check (public.can_edit_organization(organization_id));
create policy "editors update projects" on public.projects for update using (public.can_edit_organization(organization_id)) with check (public.can_edit_organization(organization_id));
create policy "editors delete projects" on public.projects for delete using (public.can_edit_organization(organization_id));
create policy "members read project sources" on public.project_sources for select using (exists(select 1 from public.projects p where p.id = project_id and public.is_organization_member(p.organization_id)));
create policy "editors manage project sources" on public.project_sources for all using (exists(select 1 from public.projects p where p.id = project_id and public.can_edit_organization(p.organization_id))) with check (exists(select 1 from public.projects p where p.id = project_id and public.can_edit_organization(p.organization_id)));
create policy "members read analyses" on public.project_analyses for select using (exists(select 1 from public.projects p where p.id = project_id and public.is_organization_member(p.organization_id)));
create policy "editors manage analyses" on public.project_analyses for all using (exists(select 1 from public.projects p where p.id = project_id and public.can_edit_organization(p.organization_id))) with check (exists(select 1 from public.projects p where p.id = project_id and public.can_edit_organization(p.organization_id)));
create policy "members read tasks" on public.project_tasks for select using (exists(select 1 from public.projects p where p.id = project_id and public.is_organization_member(p.organization_id)));
create policy "editors manage tasks" on public.project_tasks for all using (exists(select 1 from public.projects p where p.id = project_id and public.can_edit_organization(p.organization_id))) with check (exists(select 1 from public.projects p where p.id = project_id and public.can_edit_organization(p.organization_id)));
create policy "members read attachments" on public.attachments for select using (public.is_organization_member(organization_id));
create policy "editors manage attachments" on public.attachments for all using (public.can_edit_organization(organization_id)) with check (public.can_edit_organization(organization_id));
create policy "members read reusable materials" on public.reusable_materials for select using (public.is_organization_member(organization_id));
create policy "editors manage reusable materials" on public.reusable_materials for all using (public.can_edit_organization(organization_id)) with check (public.can_edit_organization(organization_id));
create policy "admins read audit logs" on public.audit_logs for select using (exists(select 1 from public.organization_members m where m.organization_id = audit_logs.organization_id and m.user_id = auth.uid() and m.role = 'admin'));

create index if not exists projects_organization_due_idx on public.projects(organization_id, due_date);
create index if not exists project_sources_project_idx on public.project_sources(project_id, created_at desc);
create index if not exists project_analyses_project_idx on public.project_analyses(project_id, version desc);
create index if not exists project_tasks_project_idx on public.project_tasks(project_id, completed);
create index if not exists attachments_project_idx on public.attachments(project_id, created_at desc);
create index if not exists reusable_materials_search_idx on public.reusable_materials using gin(tags);

insert into storage.buckets (id, name, public)
values ('project-files', 'project-files', false)
on conflict (id) do nothing;

drop policy if exists "members read project files" on storage.objects;
drop policy if exists "editors upload project files" on storage.objects;
drop policy if exists "editors update project files" on storage.objects;
drop policy if exists "editors delete project files" on storage.objects;

create policy "members read project files" on storage.objects for select
using (bucket_id = 'project-files' and public.is_organization_member((storage.foldername(name))[1]::uuid));

create policy "editors upload project files" on storage.objects for insert
with check (bucket_id = 'project-files' and public.can_edit_organization((storage.foldername(name))[1]::uuid));

create policy "editors update project files" on storage.objects for update
using (bucket_id = 'project-files' and public.can_edit_organization((storage.foldername(name))[1]::uuid))
with check (bucket_id = 'project-files' and public.can_edit_organization((storage.foldername(name))[1]::uuid));

create policy "editors delete project files" on storage.objects for delete
using (bucket_id = 'project-files' and public.can_edit_organization((storage.foldername(name))[1]::uuid));

commit;
