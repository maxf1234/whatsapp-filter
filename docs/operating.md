# Operating notes

## Adding the block list

The whole list can go in with one call. Prefixes are dialled form — country code
first, no `+`:

```bash
curl -X POST https://…/v1/rules/bulk \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prefixes":["234","91","92","880","62","63"]}'
```

Anything already on the account comes back in `skipped` rather than failing the
batch, so re-submitting a list with one new entry does the obvious thing.

For US and Canadian area codes, either send the dialled form (`1917`) or send
`917` with `"area_code": true`. A bare three-digit prefix is otherwise taken
literally: `917` on its own matches any number starting 917, which is not what
someone picking an area code means.

## Reading the activity log

`GET /v1/activity` returns the decisions newest-first with a summary beside
them. The two that matter before arming:

- `would_block` — matched, and would have been acted on if armed. This is the
  number to watch. If it contains someone you know, fix the rules before arming.
- `allowed` — an exception beat a block rule. Confirms an allow rule is doing
  what it was added for.

`unresolved_jid` means WhatsApp identified the sender by a `@lid` handle with no
phone number in it, so no rule could be evaluated. A steady stream of these
means the filter is quietly not covering those contacts.

## When someone's link dies

WhatsApp ends links for its own reasons — the phone being offline for a long
time, the subscriber removing the device, a policy action. The session goes to
`logged_out`, the worker stops reconnecting (retrying dead credentials loops
forever), and the dashboard asks them to pair again.

`sessions.last_disconnect_reason` carries the Baileys reason for anything that
needs diagnosing. `pairing failed: …` there means WhatsApp refused to issue a
code, which usually means the number is wrong or the account is rate-limited;
waiting and retrying is the only remedy.

## Rotating the encryption key

There is no re-wrap path. Changing `SESSION_ENCRYPTION_KEY` makes every stored
credential unreadable, and every subscriber has to pair again. Reading a row
written under a different key raises rather than returning noise, so the failure
is loud.

That is a deliberate trade: the alternative is keeping both the old and new key
live during a migration, which doubles the window in which either one leaking is
fatal. If you must rotate, tell subscribers first and expect to re-pair them all.

## Retention

Activity older than `EVENT_RETENTION_DAYS` (90 by default) is swept nightly by
whichever worker gets there first. There are no rollups underneath, so this is
the whole retention story — a number raised means keeping raw rows for longer,
not losing aggregates.

## Scaling past one worker

The current design assumes one. To go further, `sessions` needs an owner column
and a lease — each worker claiming a slice and renewing it, releasing on
shutdown — so that two workers never hold a socket for the same account.
Everything else already tolerates it: `claimDuePending` uses `for update skip
locked`, and the credential store is shared.

## Things that will look like bugs and are not

**A newly linked account filters nothing for a while.** Contacts have not synced
yet, so every sender reads as unknown, and history sync is off, so only new
messages are seen at all.

**The activity log shows `no_match` rows for numbers you did block.** Check the
prefix is in dialled form. `917` is not the New York area code; `1917` is.

**A pending delete disappears without happening.** Either it was cancelled, or
the account was disarmed during the delay — the sweep re-checks, and drops the
action with a `would_block` row explaining why.
