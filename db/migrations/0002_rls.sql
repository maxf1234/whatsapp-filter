-- 0002_rls.sql — row level security.
--
-- One kind of principal reaches this database as a subscriber: a logged-in user,
-- whose JWT carries sub = users.id. The worker is not a principal — it acts for
-- every account at once and runs as service_role, which bypasses these policies.
--
-- The application never filters by account_id. It publishes claims and lets RLS
-- decide, so a forgotten WHERE clause in a future route cannot show one
-- subscriber another subscriber's chats.

set search_path = public;

-- ---------------------------------------------------------------- claim helpers
--
-- SECURITY DEFINER so the lookups below do not re-enter the policies that call them.

create or replace function app.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function app.uid() returns uuid
language sql stable as $$
  select nullif(app.jwt() ->> 'sub', '')::uuid
$$;

create or replace function app.is_member(aid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from account_members m where m.account_id = aid and m.user_id = app.uid())
$$;

create or replace function app.is_owner(aid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from account_members m
     where m.account_id = aid and m.user_id = app.uid() and m.role = 'owner')
$$;

grant execute on all functions in schema app to anon, authenticated, service_role;

-- ---------------------------------------------------------------- enable RLS

alter table users              enable row level security;
alter table accounts           enable row level security;
alter table account_members    enable row level security;
alter table account_settings   enable row level security;
alter table sessions           enable row level security;
alter table session_auth_state enable row level security;
alter table rules              enable row level security;
alter table filter_events      enable row level security;
alter table pending_actions    enable row level security;

-- Force it for the table owner too, so a migration-role connection in a future
-- job does not quietly become a tenant-blind superuser over these tables.
alter table users              force row level security;
alter table accounts           force row level security;
alter table account_members    force row level security;
alter table account_settings   force row level security;
alter table sessions           force row level security;
alter table session_auth_state force row level security;
alter table rules              force row level security;
alter table filter_events      force row level security;
alter table pending_actions    force row level security;

-- ---------------------------------------------------------------- policies

create policy users_self on users
  for select to authenticated using (id = app.uid());

create policy accounts_read on accounts
  for select to authenticated using (app.is_member(id));

create policy account_members_read on account_members
  for select to authenticated using (app.is_member(account_id));

create policy account_settings_read on account_settings
  for select to authenticated using (app.is_member(account_id));
create policy account_settings_write on account_settings
  for update to authenticated
  using (app.is_owner(account_id)) with check (app.is_owner(account_id));

-- Sessions are readable but not writable by subscribers: linking and unlinking
-- go through routes that have to reach the worker as well as the table, so
-- there is no such thing as a valid direct UPDATE here.
create policy sessions_read on sessions
  for select to authenticated using (app.is_member(account_id));

-- session_auth_state gets no policy at all. RLS with no permissive policy denies
-- everything, so `authenticated` sees zero rows no matter what it asks for.
-- Only service_role (bypassrls) can read a subscriber's WhatsApp credentials.

create policy rules_read on rules
  for select to authenticated using (app.is_member(account_id));
create policy rules_insert on rules
  for insert to authenticated with check (app.is_owner(account_id));
create policy rules_update on rules
  for update to authenticated
  using (app.is_owner(account_id)) with check (app.is_owner(account_id));
create policy rules_delete on rules
  for delete to authenticated using (app.is_owner(account_id));

-- Append-only from the subscriber's side: they can read their activity and
-- cannot edit it, which is the point of keeping it.
create policy filter_events_read on filter_events
  for select to authenticated using (app.is_member(account_id));

-- A subscriber may cancel a pending destructive action — that is the whole
-- reason for the delay — but may not create or reschedule one.
create policy pending_actions_read on pending_actions
  for select to authenticated using (app.is_member(account_id));
create policy pending_actions_cancel on pending_actions
  for delete to authenticated using (app.is_owner(account_id));

-- ---------------------------------------------------------------- grants
--
-- Policies restrict; grants are still what decides which verbs exist at all.

grant select on users, accounts, account_members, sessions, filter_events to authenticated;
grant select, update on account_settings to authenticated;
grant select, insert, update, delete on rules to authenticated;
grant select, delete on pending_actions to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
