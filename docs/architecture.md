# Architecture

Three moving parts, in one process by default.

```
browser ──HTTP──> Fastify ──> Postgres <── worker ──WebSocket──> WhatsApp
  web/           api/routes/     RLS       api/worker/
```

**The API never talks to WhatsApp.** A subscriber asking to link writes a row
and returns; the worker notices, opens a socket, asks WhatsApp for a pairing
code and writes it back; the dashboard polls until it appears. Nothing in the
request path waits on WhatsApp, so a slow or refusing WhatsApp is a screen that
says "still working" rather than a timed-out HTTP request — and the API can be
scaled or restarted without dropping anybody's link.

**The worker holds one socket per linked account** and reconciles every
`WORKER_TICK_SECONDS`: it opens what should be up, closes what should not, and
reconnects with capped exponential backoff. Exactly one deployment may run it.
Two would each open a socket for the same account, and WhatsApp treats a second
connection from the same credentials as a replacement — they would fight.

## The decision is a pure function

`domain/decide.ts` takes an incoming message, the account's rules and its
settings, and returns a verdict. It touches no socket and no database.

That separation is what makes "an unarmed account never deletes" testable as a
property over every combination of settings rather than as a hope that the
socket code checks a flag in each branch it grows. The manager's job is only to
carry out what the function decided.

## Why matching is a prefix and nothing else

Country codes are variable-length and not self-delimiting: `1` is the whole
NANP, `1876` is Jamaica inside it, `234` is Nigeria and `2348` is nothing at
all. Any scheme that first parses a number into (country, area, subscriber) has
to carry a numbering-plan table, and is wrong the moment that table goes stale.

Longest-prefix matching needs no table. It is correct for country codes, correct
for area codes, and gives exceptions for free, because "more specific" and
"longer" are the same thing in a dialling plan. `dial_prefixes` exists only to
put a name next to the digits in the picker; deleting the whole table would
change no decision.

## Why credentials live in Postgres

Baileys ships `useMultiFileAuthState`, which writes a directory per session.
That is right for one bot and wrong for a service: on a container filesystem
every subscriber's login dies at the next deploy, and two replicas each hold
half the sessions with no way to find the other half.

`worker/dbAuthState.ts` implements the same `AuthenticationState` interface over
a table. The state outlives the container, a replacement worker picks up every
link, and the blast radius of a database dump is bounded by
`SESSION_ENCRYPTION_KEY` rather than by filesystem permissions.

The cost is a round trip per signal-key lookup, and a handshake does many. That
is what `makeCacheableSignalKeyStore` is wrapped around it for.

## Why held actions are a table, not a timer

A matched chat waits out `delete_delay_seconds` in `pending_actions`, and the
worker sweeps it. In-memory timers would be simpler and wrong in both
directions: a restart between the match and the delete would silently drop an
enforcement the subscriber expected, and — worse — a timer that survived in
another replica would perform one they had cancelled.

The table also gives the flood behaviour for free. A second message from a chat
already pending refreshes the message anchor but leaves `due_at` alone, so a
spammer sending ten messages can neither push their own deletion further away
nor cause ten of them. That is a unique constraint on `(session_id, remote_jid)`
doing the work, not a code path.

Each sweep re-reads the account's settings, which is the part that matters: a
subscriber who disarms during the delay is telling us to stop, and a queue that
acted on a two-minute-old decision would ignore them.

## Trust boundaries

| Principal | How it connects | What it can reach |
|---|---|---|
| Subscriber | `set local role authenticated` + JWT claims | Own account's rules, settings, activity, session status. Never `session_auth_state`. |
| Worker | `set local role service_role` (bypassrls) | Everything, for every tenant. It is the only reader of credentials. |
| Migration role | Table owner | Everything, and `force row level security` is set so it is not exempt either. |

`set local` unwinds with the transaction, so a pooled connection cannot leak one
request's claims into the next.

## What is deliberately not here

**No message content, anywhere.** Not in the activity log, not in the request
log. The redaction is in the serialiser rather than at each call site.

**No history sync.** `shouldSyncHistoryMessage` returns false. The filter sees
messages from the moment it links and no earlier.

**No sending.** The socket reads and acts on chats. It never sends a message,
which is both the least provocative shape available under WhatsApp's terms and
one fewer thing that can go wrong on someone else's account.
