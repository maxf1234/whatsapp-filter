-- 0005_default_policy.sql — allowlist mode.
--
-- Until now a rule set could only ever be a blocklist: anything no rule matched
-- passed, so "block everything except South Africa" was inexpressible. Writing a
-- rule per country would not fix it either — the list would be wrong the moment
-- a prefix nobody thought of arrived, which is exactly the case an allowlist is
-- for.
--
-- `default_policy` decides what happens to a number no rule matched. It defaults
-- to 'allow', which is the behaviour every existing account already has, so this
-- migration changes nothing for anyone until they ask for it.

set search_path = public;

create type default_policy as enum ('allow', 'block');

alter table account_settings
  add column default_policy default_policy not null default 'allow';

comment on column account_settings.default_policy is
  'What happens to a number no rule matched. ''block'' turns allow rules into an '
  'allowlist and is the only way to express "everything except these".';
