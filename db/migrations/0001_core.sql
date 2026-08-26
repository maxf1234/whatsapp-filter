-- 0001_core.sql — core schema for the WhatsApp number filter.
--
-- Every tenant-owned table carries account_id and is scoped by RLS (0002_rls.sql).
-- Composite foreign keys on (id, account_id) make a cross-account row physically
-- impossible to insert, so RLS is not the only thing keeping two subscribers apart.

create extension if not exists pgcrypto;
create schema if not exists app;

-- The migration role is named "app" and "$user" leads the default search_path,
-- so without this every table would land in the app schema instead of public.
set search_path = public;

-- Supabase ships these roles; create them locally so the same migrations run
-- against a plain Postgres in CI and on a developer machine.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- The API connects as this role and switches with `set local role` per request
-- (see api/src/lib/db.ts). Postgres 16 grants the creating role ADMIN OPTION but
-- not SET, so without this the switch is denied. Skipped without complaint when
-- the roles were made by someone else, as on Supabase, where the grant is theirs
-- to make.
do $$
begin
  execute format(
    'grant anon, authenticated, service_role to %I with inherit false, set true',
    current_user);
exception when insufficient_privilege then
  raise notice 'could not grant the app roles to %; grant them by hand', current_user;
end $$;

grant usage on schema public, app to anon, authenticated, service_role;

-- ---------------------------------------------------------------- enums

create type member_role as enum ('owner', 'member');

-- Where a paired WhatsApp connection is in its life.
--   unlinked   — created, no pairing attempted yet
--   pairing    — a pairing code has been issued and is waiting to be typed
--   linked     — the socket has completed a handshake at least once
--   logged_out — WhatsApp ended the link from the phone side; creds are dead
--   revoked    — the subscriber unlinked it here
create type session_status as enum ('unlinked', 'pairing', 'linked', 'logged_out', 'revoked');

create type rule_kind as enum ('block', 'allow');

-- What the filter does to a conversation whose number matched a block rule.
-- 'log_only' records the match and touches nothing; every account starts there
-- in effect because enforcement is additionally gated on account_settings.armed.
create type filter_action as enum ('log_only', 'archive', 'delete', 'block_and_delete');

-- Why a message got the outcome it did. Kept separate from the action so the
-- activity log can answer "why was nothing done here?" without guessing.
create type filter_decision as enum (
  'blocked',          -- matched a block rule and enforcement ran
  'would_block',      -- matched a block rule but the account is not armed
  'allowed',          -- an allow rule beat the block rule
  'no_match',         -- no rule matched this number
  'skipped_group',    -- group chat and group handling is off
  'skipped_known',    -- number is in the subscriber's contacts and that exemption is on
  'skipped_self',     -- the subscriber's own message
  'unresolved_jid',   -- a @lid identity we could not map back to a phone number
  'error');           -- enforcement was attempted and WhatsApp refused

-- ---------------------------------------------------------------- identity

-- On Supabase this table is auth.users; the FKs below point at it either way.
create table users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  created_at timestamptz not null default now()
);

create table accounts (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete restrict,
  plan          text not null default 'free',
  created_at    timestamptz not null default now()
);

create table account_members (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       member_role not null default 'owner',
  unique (account_id, user_id)
);
create index account_members_user_idx on account_members(user_id);

-- ---------------------------------------------------------------- settings

-- One row per account, created with the account so no route has to handle "no
-- settings yet". `armed` is the safety catch: an account can be configured in
-- full, with rules matching real chats, and still delete nothing until someone
-- deliberately arms it. The action defaults to 'delete' because that is what
-- subscribers ask for, but the pair (action='delete', armed=false) is the state
-- every account is born in, and it is not enforcing.
create table account_settings (
  account_id              uuid primary key references accounts(id) on delete cascade,
  action                  filter_action not null default 'delete',
  armed                   boolean not null default false,
  armed_at                timestamptz,
  -- Deleting a chat on WhatsApp is not reversible from here. Holding a matched
  -- chat for a few minutes before the delete lands gives a subscriber who has
  -- just armed a bad rule a window to see it in the activity log and disarm.
  delete_delay_seconds    int not null default 120 check (delete_delay_seconds between 0 and 86400),
  -- Off by default: a number already in the subscriber's address book is
  -- someone they chose to know, whatever its country code.
  apply_to_known_contacts boolean not null default false,
  apply_to_groups         boolean not null default false,
  reject_calls            boolean not null default true,
  updated_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------- sessions

-- A paired WhatsApp connection. The subscriber's own phone number lives here;
-- the credentials that speak for it live in session_auth_state, which no
-- subscriber-facing role can read.
create table sessions (
  id                      uuid primary key default gen_random_uuid(),
  account_id              uuid not null references accounts(id) on delete cascade,
  -- E.164 without the '+', which is what both WhatsApp JIDs and our rules use.
  phone_e164              text not null check (phone_e164 ~ '^[1-9][0-9]{6,14}$'),
  status                  session_status not null default 'unlinked',
  -- WhatsApp issues an 8-character pairing code that the subscriber types into
  -- Linked Devices. It is single-use and short-lived; we store it only until
  -- the link completes so the dashboard can display it while polling.
  pairing_code            text,
  pairing_requested_at    timestamptz,
  pairing_expires_at      timestamptz,
  -- The JID WhatsApp assigns once linked, e.g. 15551234567:12@s.whatsapp.net.
  wa_jid                  text,
  linked_at               timestamptz,
  last_connected_at       timestamptz,
  last_disconnect_reason  text,
  revoked_at              timestamptz,
  created_at              timestamptz not null default now(),
  unique (id, account_id)
);
-- One live session per account. Revoked and logged-out rows stay for the audit
-- trail, so the constraint is partial rather than a plain unique on account_id.
create unique index sessions_one_live_per_account
  on sessions(account_id)
  where status in ('unlinked', 'pairing', 'linked');
create index sessions_status_idx on sessions(status) where status = 'linked';

-- Baileys' AuthenticationState, one row per key it asks to persist ('creds',
-- 'pre-key-3', 'session-15551234567.0', …). The value is AES-256-GCM
-- ciphertext: a dump of this table without SESSION_ENCRYPTION_KEY is inert,
-- and with the key it is a working login to someone's WhatsApp. Treat it as
-- the most sensitive table in the schema — RLS grants no subscriber any access
-- to it at all, only the worker's service role.
create table session_auth_state (
  session_id uuid not null references sessions(id) on delete cascade,
  key        text not null,
  ciphertext bytea not null,
  iv         bytea not null,
  auth_tag   bytea not null,
  updated_at timestamptz not null default now(),
  primary key (session_id, key)
);

-- ---------------------------------------------------------------- rules

-- A rule matches on the leading digits of the full international number, which
-- is why one mechanism covers both "+234, all of Nigeria" (prefix '234') and
-- "the 917 area code" (prefix '1917'): a NANP number is 1 + NPA + 7 digits, so
-- an area code is just a longer country prefix.
--
-- Longest prefix wins, and 'allow' beats 'block' only by being longer — which
-- is the useful reading: block 234, then allow 234803… for the one contact
-- there you actually talk to.
create table rules (
  account_id uuid not null references accounts(id) on delete cascade,
  id         uuid not null default gen_random_uuid(),
  kind       rule_kind not null default 'block',
  prefix     text not null check (prefix ~ '^[1-9][0-9]{0,14}$'),
  label      text,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (id),
  -- A prefix can carry one verdict per account; two rows disagreeing about the
  -- same digits would make the match order load-bearing, and it is not.
  unique (account_id, prefix),
  unique (id, account_id)
);
create index rules_account_enabled_idx on rules(account_id) where enabled;

-- ---------------------------------------------------------------- activity

-- Every message the filter looked at and what it decided. This is the record a
-- subscriber checks after arming, and the only place a deleted chat leaves a
-- trace, so it is written for 'no_match' too and not only for the matches.
create table filter_events (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references accounts(id) on delete cascade,
  session_id     uuid,
  occurred_at    timestamptz not null default now(),
  remote_jid     text not null,
  -- Null when the JID was a @lid we could not map to a number.
  phone_e164     text,
  matched_prefix text,
  matched_rule_id uuid,
  decision       filter_decision not null,
  action_taken   filter_action,
  is_group       boolean not null default false,
  -- Kept for 'error' rows so a failing enforcement path is debuggable without
  -- turning on message-level logging. Never holds message content.
  detail         text,
  foreign key (session_id, account_id) references sessions(id, account_id) on delete set null,
  foreign key (matched_rule_id, account_id) references rules(id, account_id) on delete set null
);
create index filter_events_account_time_idx on filter_events(account_id, occurred_at desc);
create index filter_events_occurred_idx on filter_events(occurred_at);

-- Chats matched while a delete delay is running. The worker sweeps this table
-- rather than holding timers in memory, so a restart between the match and the
-- delete does not silently drop the enforcement — or silently perform one the
-- subscriber disarmed in the meantime, since the sweep re-checks armed state.
create table pending_actions (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references accounts(id) on delete cascade,
  session_id   uuid not null,
  remote_jid   text not null,
  action       filter_action not null,
  -- The message key the chat-modify call needs to address the conversation.
  last_message jsonb not null,
  due_at       timestamptz not null,
  created_at   timestamptz not null default now(),
  attempts     int not null default 0,
  foreign key (session_id, account_id) references sessions(id, account_id) on delete cascade,
  unique (session_id, remote_jid)
);
create index pending_actions_due_idx on pending_actions(due_at);
