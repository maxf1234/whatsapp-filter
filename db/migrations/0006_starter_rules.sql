-- 0006_starter_rules.sql — the block list a new account starts with.
--
-- Copied into `rules` at signup so a subscriber lands on a dashboard that
-- already does something, rather than an empty one they have to research. They
-- own the copy from that moment: removing a starter rule removes it for good,
-- and editing this table never reaches back into an existing account.
--
-- It costs nothing to be wrong here, because accounts are still born disarmed.
-- A starter list a subscriber disagrees with shows up as `would_block` rows
-- naming a country they wanted, and they delete the rule before arming.
--
-- South Africa (+27) is deliberately absent.

set search_path = public;

create table starter_rules (
  prefix     text primary key check (prefix ~ '^[1-9][0-9]{0,14}$'),
  kind       rule_kind not null default 'block',
  -- Lower sorts first in the dashboard. Not load-bearing; the matcher is
  -- order-independent by construction.
  sort_order int not null default 100
);

grant select on starter_rules to authenticated, service_role;

insert into starter_rules (prefix) values
  -- West & Central Africa
  ('234'),   -- Nigeria
  ('233'),   -- Ghana
  ('225'),   -- Cote d'Ivoire
  ('221'),   -- Senegal
  ('229'),   -- Benin
  ('228'),   -- Togo
  ('237'),   -- Cameroon
  -- East & North Africa
  ('254'),   -- Kenya
  ('20'),    -- Egypt
  ('212'),   -- Morocco
  -- South Asia
  ('91'),    -- India
  ('92'),    -- Pakistan
  ('880'),   -- Bangladesh
  -- Southeast & East Asia
  ('62'),    -- Indonesia
  ('63'),    -- Philippines
  ('84'),    -- Vietnam
  ('60'),    -- Malaysia
  ('855'),   -- Cambodia
  ('95'),    -- Myanmar
  ('86'),    -- China
  -- Eastern Europe & Middle East
  ('7'),     -- Russia / Kazakhstan
  ('380'),   -- Ukraine
  ('90'),    -- Turkey
  ('971'),   -- United Arab Emirates
  ('964'),   -- Iraq
  -- Caribbean members of +1, which are countries rather than area codes
  ('1876'),  -- Jamaica
  ('1809'),  -- Dominican Republic
  ('1829'),  -- Dominican Republic
  ('1849');  -- Dominican Republic

-- A guard rather than a comment: if someone adds +27 to the list above, the
-- migration fails instead of quietly shipping the one country that was
-- explicitly meant to stay reachable.
do $$
begin
  if exists (select 1 from starter_rules where prefix = '27') then
    raise exception 'South Africa (+27) must not be in the starter block list';
  end if;
end $$;
