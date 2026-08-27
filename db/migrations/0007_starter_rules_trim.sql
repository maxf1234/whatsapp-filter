-- 0007_starter_rules_trim.sql — six countries come off the starter block list.
--
-- Egypt, the UAE, Russia, Indonesia, China and Ukraine reach subscribers
-- normally from now on. A new migration rather than an edit to 0006, because
-- migrations are recorded per-database: editing the earlier file would change
-- nothing for anyone who has already run it, which is the whole point of
-- keeping them append-only.
--
-- This changes what NEW accounts are seeded with. Existing accounts keep the
-- copy they were given, by design — see the note on seedStarterRules. To apply
-- it to accounts that already exist, that is a deliberate act:
--
--   delete from rules where prefix in ('20','971','7','62','86','380');

set search_path = public;

delete from starter_rules where prefix in (
  '20',   -- Egypt
  '971',  -- United Arab Emirates
  '7',    -- Russia / Kazakhstan
  '62',   -- Indonesia
  '86',   -- China
  '380'   -- Ukraine
);

-- Countries that must stay reachable. The guard exists because this list has
-- now changed twice, and a careless edit to 0006 putting one back would ship
-- silently. Add to this set whenever a country is taken off the block list.
do $$
declare
  reachable text[] := array[
    '27',   -- South Africa
    '20',   -- Egypt
    '971',  -- United Arab Emirates
    '7',    -- Russia / Kazakhstan
    '62',   -- Indonesia
    '86',   -- China
    '380'   -- Ukraine
  ];
  offenders text;
begin
  select string_agg(prefix, ', ' order by prefix)
    into offenders
    from starter_rules
   where prefix = any(reachable);

  if offenders is not null then
    raise exception
      'these prefixes must not be in the starter block list: %', offenders;
  end if;
end $$;
