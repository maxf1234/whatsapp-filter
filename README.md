# whatsapp-filter

A WhatsApp number filter as a service. Subscribers sign up on a landing page,
pair their WhatsApp with an eight-character code, name the country codes and
area codes they never want to hear from, and matching conversations stop
arriving.

- [What it does](#what-it-does)
- [What it cannot do](#what-it-cannot-do)
- [Status](#status)
- [Quick start](#quick-start)
- [How rules work](#how-rules-work)
- [What a new account starts with](#what-a-new-account-starts-with)
- [The safety model](#the-safety-model)
- [What the filter sees](#what-the-filter-sees)
- [Actions](#actions)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Deploying](#deploying)
- [Operating it](#operating-it)
- [Security](#security)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Before you point this at a real number](#before-you-point-this-at-a-real-number)
- [Outstanding work](#outstanding-work)

```
web/                  Landing page, pairing screen, dashboard (vanilla, no build step)
api/src/routes/       Fastify: signup, linking, rules, settings, activity
api/src/domain/       The filter itself — normalisation, matching, the decision
api/src/worker/       One supervised Baileys socket per account, and enforcement
api/src/lib/          Config, database, auth, crypto, errors, logging
api/test/             84 tests, run against a live Postgres
db/migrations/        Schema, RLS policies, the dial-plan reference data
docs/                 Architecture, operating notes, the country-code list
scripts/migrate.sh    Migration runner
Dockerfile            One image for both the web and worker roles
railway.json          Railway build and release configuration
```

## What it does

1. Somebody signs up with an email on the landing page.
2. They enter their WhatsApp number. The service asks WhatsApp for a pairing
   code and shows it; they type it into **WhatsApp → Linked Devices → Link a
   device → Link with phone number instead**. The service is now a linked device
   on their account, the same way WhatsApp Web is.
3. They pick the dialling prefixes they never want a conversation from — whole
   countries, single area codes, or both — plus any exceptions.
4. Every message that arrives is checked against those rules. Matches are logged
   and, once the account is armed, the conversation is deleted (or archived, or
   the sender blocked, depending on the configured action). Calls from matching
   prefixes are declined.

Everything not matched reaches them exactly as it does today.

## What it cannot do

**It cannot stop a message from reaching the phone.** Pairing creates a *linked
device*, and WhatsApp delivers every message to every device. There is no
interception point available to a linked device, and any product claiming
otherwise on WhatsApp is either running a business API number or lying.

What a linked device *can* do is act the instant a message lands, on the
subscriber's phone and every other device they have linked, exactly as if they
had done it by hand: delete the chat, archive it, mute it, mark it read, block
the sender, decline the call. That is what this service does, within a couple of
seconds of delivery.

So the honest description is **automated reaction, not interception**. A
subscriber may briefly see a notification before the chat disappears. If that
matters to them, `archive` is the gentler action and `block_and_delete` is the
one that stops it happening twice.

## Status

**Everything except the WhatsApp socket is built and tested.** 107 tests run
against a live Postgres 16, covering tenant isolation, the matcher, both
policies, the arming gate, the pairing flow, credential encryption, the
held-action queue and retention. The API, the dashboard and the database have been driven end to end,
including in a real browser at desktop and phone widths, light and dark.

**The Baileys socket has never been connected to a real WhatsApp account.**
Everything it hands off to — the auth-state store, the decision engine, the
queue — is tested, but pairing, the `messages.upsert` stream and `chatModify`
have not run against WhatsApp itself. Expect to spend the first session with a
throwaway number watching the log. See [Before you point this at a real
number](#before-you-point-this-at-a-real-number).

## Quick start

Postgres 16 and Node 22.

```bash
# database
createdb wafilter_dev
DATABASE_URL=postgres://…/wafilter_dev ./scripts/migrate.sh

# service
cd api
npm install
cp ../.env.example ../.env      # then edit it
npm start
```

Open <http://localhost:8080>, sign up with any email, and you are on the pairing
screen. In `AUTH_MODE=dev` the signup response carries a usable session token, so
no identity provider is needed to try the whole flow.

The migration role needs `BYPASSRLS`, because it creates `service_role`, which
has it:

```bash
psql -c 'alter role app bypassrls'
```

On Supabase the roles already exist and the migration skips that block with a
notice.

To set rules without the dashboard:

```bash
TOKEN=$(curl -sX POST localhost:8080/v1/signup \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -sX POST localhost:8080/v1/rules/bulk \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prefixes":["234","91","92","880"]}'
```

## How rules work

A rule is a **leading-digit prefix on the full international number**, written
in dialled form with no `+`. The **longest matching prefix wins**.

| Rule      | Kind    | Matches                                                  |
|-----------|---------|----------------------------------------------------------|
| `234`     | block   | every Nigerian number                                     |
| `91`      | block   | every Indian number                                       |
| `1917`    | block   | the 917 area code — a NANP number is `1` + area code + 7 digits |
| `1876`    | block   | Jamaica, which shares +1 but has its own area code        |
| `234803`  | allow   | the one Lagos number you do talk to                       |
| `2348031` | block   | a narrower slice inside that exception                    |

Three consequences worth understanding, because they are the whole design:

**There is no separate "area code mode."** An area code is a longer country
prefix. One matcher covers both, so there is no mode to set wrong.

**Exceptions need no new concept.** `234803` beats `234` by being longer, so
"block Nigeria except my supplier" is two rules, not a feature. Exceptions can
themselves have exceptions, indefinitely — `91` block, `9198` allow, `919876`
block all coexist and resolve by length.

**Order never matters.** The schema holds one verdict per `(account, prefix)`,
so two rules can never disagree about the same digits and the winner is always
unique. `api/test/phone.test.ts` asserts that shuffling the rule list cannot
change a decision.

### Entering prefixes

`POST /v1/rules` accepts what a person actually types — `+234`, `234`,
`00234`, `(917)`. Digits are extracted, and a leading `00` or `011`
international prefix is stripped.

A **bare three-digit input is taken literally** unless you say otherwise: `917`
means "any number starting 917", not the New York area code. Pass
`"area_code": true` (the dashboard's checkbox) to have three digits read as a
NANP area code and stored as `1917`. Prefixes coming from the picker are already
in dialled form and are never re-prefixed.

### Numbers the matcher accepts

E.164 without the `+`: 7 to 15 digits, no leading zero. The lower bound is
deliberately loose — real numbering plans go down to 8 digits including the
country code — because a bound that is too tight rejects a real sender rather
than a fake one. Anything that fails is returned as "no usable number" rather
than as a best guess; a wrong normalisation here would delete the wrong
conversation.

## What a new account starts with

Signup copies `starter_rules` into the account as 23 block rules: Nigeria,
Ghana, Côte d'Ivoire, Senegal, Benin, Togo, Cameroon, Kenya, Morocco, India,
Pakistan, Bangladesh, the Philippines, Vietnam, Malaysia, Cambodia, Myanmar,
Turkey, Iraq, Jamaica and the Dominican Republic.

**South Africa, Egypt, the UAE, Russia, Indonesia, China and Ukraine are
deliberately absent** and reach subscribers normally. A guard in
`db/migrations/0007_starter_rules_trim.sql` fails the migration if any of them
is ever added back, rather than shipping it quietly — the list has changed
twice, and a careless edit to an earlier migration would otherwise go unnoticed.

It is a **copy**, not a reference. The moment a subscriber deletes one it stays
deleted; a shared list would resurrect it, and a filter that puts back a rule you
removed is worse than one that shipped empty. Adding a migration that changes
`starter_rules` changes what *new* accounts get and never reaches back into an
existing one — applying a change to accounts that already exist is a deliberate
`delete from rules where prefix in (…)`.

Getting the list wrong is cheap, because accounts are still born disarmed: a
country a subscriber wanted shows up as `would_block` rows naming it, and they
delete the rule before arming.

The full list with prefixes, and the countries left reachable:
[docs/country-codes.md](docs/country-codes.md).

## Block list or allow list

`settings.default_policy` decides what happens to a number **no rule matched**.

- `allow` (**the default**) — rules are a **block list**. Named prefixes are
  caught, everything else gets through.
- `block` — rules are an **allow list**. Allow rules name what may through and
  *every other number on earth* is caught. This is the only way to express
  "everything except these": a block list enumerating every country is wrong the
  moment a prefix nobody thought of arrives, which is the whole case an allow
  list exists for.

An allow rule wins outright under either policy, so it is the same rule with the
same meaning in both — the allow-list entry, or the exception carved out of a
longer block rule.

Allow-list mode is a large change in reach and is treated as one: the dashboard
confirms before switching, names what is currently allowed, and the arming
confirmation reports how many prefixes get through rather than how many rules
are active. Saved contacts stay exempt, which is the safety valve that makes it
survivable at all.

One deliberate hole: a `@lid` contact has no readable number, so allow-list mode
logs it as `unresolved_jid` rather than catching it. The strict reading would be
"not provably allowed, so catch it", but that means deleting conversations
nobody can write a rule for.

## The safety model

The default action is **delete the conversation**, and WhatsApp has no undo for
that. Three things stand in front of it.

### 1. Accounts are born disarmed

`action` defaults to `delete` and `armed` defaults to `false`. That pair means
*watch*: rules are evaluated, matches are written to the activity log as
`would_block`, and nothing is touched.

There is no combination of settings that makes an unarmed account act. That is
asserted as a property over every combination of action × groups × known
contacts in `api/test/decide.test.ts`, not as one happy path.

### 2. Arming is deliberate and dated

One switch, which names what will happen before it flips. `armed_at` is stamped
by the database rather than supplied by the caller, so the activity log can
always answer "was this account armed when that message arrived?" against a
timestamp nobody had the chance to backdate. Disarming clears it.

### 3. Deletes are held

A match queues the action in `pending_actions` for `delete_delay_seconds` — two
minutes by default — and the dashboard shows it with a Cancel button. When the
delay runs out, the worker **re-reads the account's settings** rather than
trusting the decision it made two minutes ago. A subscriber who disarms during
the delay is telling the service to stop, and it stops; the held action is
dropped with a `would_block` row explaining why.

The queue is a table rather than in-memory timers, which matters in both
directions: a restart between the match and the delete must not silently drop an
enforcement, and a timer surviving in another replica must not perform one that
was cancelled.

**Archiving is reversible and is not delayed. Call rejection destroys nothing and
is not gated on arming at all.**

## What the filter sees

**Only messages arriving from now on.** `shouldSyncHistoryMessage` returns
false. Pulling a subscriber's history would mean holding years of their
conversations in a process with no business seeing any of it; the cost is that
the filter is blind to anything older than the link.

**Group chats are off by default.** When `apply_to_groups` is on, the number
judged is the individual participant's — a group has no country code of its own,
and the action still applies to the group chat.

**Saved contacts are exempt by default.** Someone in the address book is someone
the subscriber chose to know, whatever their country code. Note that Baileys
only knows the address book once contacts have synced, and a freshly linked
session has not synced yet, so unknown reads as "not known". The exemption
therefore only ever *adds* safety once the sync lands — which is why
`apply_to_known_contacts` defaults to off rather than relying on it.

**The subscriber's own messages are never acted on**, including ones mirrored
from their phone or another linked device.

**`@lid` JIDs carry no phone number.** WhatsApp's newer linked-identity handles
are deliberately not numbers. Those are recorded as `unresolved_jid` rather than
passed off as "no match", so "the filter never fires on this contact" shows up
in the log instead of looking like a quiet pass. This is the most likely thing
to need work once it meets real traffic.

**Message content is never stored.** The activity log holds the number, the
matched prefix and the decision. `lib/logging.ts` redacts bodies at the log
serialiser rather than at each call site, so a future route cannot log one by
forgetting.

### Decisions

Every message the filter looks at produces one of these, and all but
`skipped_self` are written to the activity log:

| Decision | Meaning |
|---|---|
| `blocked` | matched a block rule, and enforcement ran |
| `would_block` | matched a block rule, but the account is not armed |
| `allowed` | a longer allow rule beat the block rule |
| `no_match` | no rule matched this number |
| `skipped_group` | group chat, and group handling is off |
| `skipped_known` | number is in the address book and that exemption is on |
| `skipped_self` | the subscriber's own message (not logged — it would drown the log) |
| `unresolved_jid` | a `@lid` or malformed JID with no number to read |
| `error` | enforcement was attempted and WhatsApp refused |

## Actions

Set per account via `settings.action`.

| Action | What happens | Reversible |
|---|---|---|
| `log_only` | Nothing. The match is recorded and the chat is untouched. | n/a |
| `archive` | Mark read, mute for 8 hours, archive. Read first, because an archived chat still carrying an unread badge is worse than doing nothing. | yes, from the phone |
| `delete` | Delete the conversation. **Default.** | **no** |
| `block_and_delete` | Block the sender at the WhatsApp account level, then delete. Block first, because the other order leaves a window where the chat is gone but the sender can open a fresh one. | block yes, delete no |

`block_and_delete` is visible to the sender — their messages stop delivering.
The others are silent.

If the block half of `block_and_delete` fails, the delete still runs and the
failure is recorded in the event's `detail`; a failed block should not cost you
the enforcement that was the point.

## Architecture

```
browser ──HTTP──> Fastify ──> Postgres <── worker ──WebSocket──> WhatsApp
  web/           api/routes/     RLS       api/worker/
```

**The API never talks to WhatsApp.** A subscriber asking to link writes a row
and returns; the worker notices, opens a socket, asks WhatsApp for a pairing
code and writes it back; the dashboard polls until it appears. Nothing in the
request path waits on WhatsApp, so a slow or refusing WhatsApp is a screen
saying "still working" rather than a timed-out request — and the API can be
restarted or scaled without dropping anybody's link.

**The worker holds one socket per linked account** and reconciles every
`WORKER_TICK_SECONDS`: opens what should be up, closes what should not,
reconnects dropped sockets with capped exponential backoff, drains the held-action
queue, and sweeps expired activity once a day. Exactly one deployment may run
it — see [Scaling](#scaling-past-one-worker).

**The decision is a pure function.** `domain/decide.ts` takes a message, the
rules and the settings, and returns a verdict. It touches no socket and no
database, which is what makes "an unarmed account never acts" testable as a
property rather than a hope that the socket code checks a flag in every branch
it grows. The manager only carries out what the function decided.

Longer form, including why credentials live in Postgres and why the held-action
queue is a table: [docs/architecture.md](docs/architecture.md).

## Data model

| Table | Holds |
|---|---|
| `users`, `accounts`, `account_members` | Identity and tenancy. One user, one account, for now. |
| `account_settings` | One row per account, created with it. Action, armed, delay, scope flags. |
| `sessions` | The paired WhatsApp connection: number, status, pairing code, disconnect reason. |
| `session_auth_state` | Baileys credentials, one row per key, AES-256-GCM sealed. **No RLS policy at all.** |
| `rules` | `(account_id, prefix)` unique, kind, label, enabled. |
| `filter_events` | The activity log. Number, matched prefix, decision, action taken. Never content. |
| `pending_actions` | Held destructive actions. `(session_id, remote_jid)` unique. |
| `starter_rules` | The 23-prefix block list copied onto each new account at signup. |
| `dial_prefixes` | Reference labels for the picker. 231 countries, 412 NANP area codes. |

Session status moves `unlinked → pairing → linked`, and out to `logged_out`
(WhatsApp ended it) or `revoked` (the subscriber did). A partial unique index
allows one live session per account while keeping the dead ones for audit.

Tenant-owned tables carry `account_id`, and composite foreign keys on
`(id, account_id)` make a cross-account row physically impossible to insert — so
RLS is not the only thing keeping two subscribers apart.

`dial_prefixes` is a convenience, not a dependency. Matching works on raw digits
and never consults it; deleting the whole table would change no decision. Labels
are advisory, and NANP area codes in particular get reassigned over time.

## Configuration

All read once at startup, so a missing value fails the boot rather than the
first request.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://app:app@127.0.0.1:5432/wafilter_dev` | |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `JWT_SECRET` | dev placeholder | **Required in production.** |
| `JWT_ISSUER` | `whatsapp-filter` | |
| `SESSION_TOKEN_TTL_HOURS` | `336` (14 days) | |
| `AUTH_MODE` | `dev` | `dev` mints a session from an email alone. **Production refuses to boot with it.** `external` verifies tokens from your IdP and issues none. |
| `SESSION_ENCRYPTION_KEY` | *(empty)* | 64 hex chars. **Required in production.** See below. |
| `RUN_WORKER` | `true` | `false` serves the API alone. Exactly one deployment should have it true. |
| `WORKER_TICK_SECONDS` | `20` | Socket reconcile and queue drain interval. |
| `PAIRING_CODE_TTL_SECONDS` | `180` | We stop showing a code at roughly the point WhatsApp stops accepting it. |
| `EVENT_RETENTION_DAYS` | `90` | Nightly sweep. No rollups underneath, so this is the whole retention story. |
| `WEB_ROOT` | `../web` relative to the build | Where the static front end lives. |
| `LOG_LEVEL` | `info` | |
| `NODE_ENV` | — | `production` turns on the boot guards. |

Generate the encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Boot guards

With `NODE_ENV=production` the service refuses to start if `AUTH_MODE=dev`, if
`JWT_SECRET` is unset, or if `SESSION_ENCRYPTION_KEY` is unset. Each failure
names what is wrong and why it matters.

## API reference

All routes are JSON. Everything except `/healthz`, `/v1/signup` and
`/v1/sessions` needs `Authorization: Bearer <token>`.

Errors are `{ "error": "<code>", "message": "…" }` with a matching status.
Validation failures add an `issues` array.

### Auth

| | |
|---|---|
| `POST /v1/signup` | `{email}` → `{account_id, email, token, auth_mode}`. Creates the account, its settings and the starter block list. Idempotent: signing up twice returns the same account and does not re-seed rules the subscriber deleted. `token` is null when `AUTH_MODE=external`. |
| `POST /v1/sessions` | `{email}` → `{token, account_id}`. Dev mode only; 403 otherwise. |
| `GET /v1/me` | Everything the dashboard needs for its first frame: account, role, settings, session summary. |

### Linking

| | |
|---|---|
| `POST /v1/link` | `{phone}` → `{session_id, phone_e164, status, pairing_code}`. `pairing_code` is null on the first call by design — the worker has not been asked yet. Re-requesting while pairing resets the code. 409 `already_linked` if a different number is live. |
| `GET /v1/link` | Polled by the pairing screen. Returns the code once the worker writes one, and null once it has expired — showing a code WhatsApp will reject reads as a broken product. |
| `DELETE /v1/link` | Unlinks and **deletes the credential rows**, not just the status. |

### Rules

| | |
|---|---|
| `GET /v1/rules` | `{rules}`, ordered shortest prefix first. |
| `POST /v1/rules` | `{prefix, kind?, label?, area_code?}` → 201 `{rule}`. `kind` defaults to `block`. Label is filled from the dial plan when omitted. 409 `duplicate_prefix`. |
| `POST /v1/rules/bulk` | `{prefixes[], kind?, area_code?}` → `{created, skipped}`. Prefixes already on the account are reported rather than failing the batch, so re-submitting a list with one new entry does the obvious thing. Up to 500 at a time. |
| `PATCH /v1/rules/:id` | `{kind?, label?, enabled?}` → `{rule}`. |
| `DELETE /v1/rules/:id` | `{deleted: true}`. |
| `GET /v1/dial-prefixes` | `?kind=country\|nanp_area&q=<search>` → `{prefixes}`. Powers the picker; searches name or leading digits. |

### Settings

| | |
|---|---|
| `GET /v1/settings` | `{settings}`. |
| `PATCH /v1/settings` | Any of `action`, `armed`, `default_policy` (`allow`\|`block`), `delete_delay_seconds` (0–86400), `apply_to_known_contacts`, `apply_to_groups`, `reject_calls`. Returns the whole settings object. |

### Activity

| | |
|---|---|
| `GET /v1/activity` | `?limit=1..500&before=<iso>&decision=<decision>` → `{events, summary}`. Newest first; summary is a decision→count map over the last 7 days. |
| `GET /v1/pending` | Held actions with their `due_at`. |
| `DELETE /v1/pending/:id` | Cancels one. This is the escape hatch the delay exists for. |

### Health

`GET /healthz` → `{ok: true}`. No auth, no database round trip.

## Deploying

Baileys needs a long-lived process, which rules out pure serverless — but **not**
a persistent disk, because credentials live in Postgres rather than on a volume.
That is what makes this multi-tenant: a replacement container picks up every
subscriber's link, and there is no per-session directory to lose on redeploy.

`Dockerfile` and `railway.json` are set up for Railway with a Postgres plugin.
Set `DATABASE_URL`, `JWT_SECRET`, `SESSION_ENCRYPTION_KEY` and
`NODE_ENV=production`; the release command runs migrations before starting.

The same image serves both roles. To split web from worker, run two services off
it with `RUN_WORKER=false` on the web one.

### Scaling past one worker

The current design assumes exactly one. Two workers would each open a socket for
the same account, and WhatsApp treats a second connection from the same
credentials as a replacement — they would fight.

To go further, `sessions` needs an owner column and a lease: each worker claims
a slice and renews it, releasing on shutdown. Everything else already tolerates
it — `claimDuePending` uses `for update skip locked`, and the credential store
is shared.

The API scales horizontally today with `RUN_WORKER=false`.

## Operating it

Day-to-day notes, including how to read the activity log, what to do when
someone's link dies, and the things that look like bugs and are not:
[docs/operating.md](docs/operating.md).

The list of country codes to choose from, grouped by region:
[docs/country-codes.md](docs/country-codes.md).

## Security

**The application never filters by `account_id`.** It publishes JWT claims and
lets RLS decide, so a forgotten `WHERE` clause in a future route cannot show one
subscriber another's chats. `api/test/rls.test.ts` is the test file that matters
most here — it asserts the boundary directly rather than through the routes that
rely on it.

**`session_auth_state` has RLS on and no policy at all.** RLS with no permissive
policy denies everything, and the grant is missing too, so `authenticated` gets
a permission error rather than an empty result. Only the worker's `service_role`
can read a subscriber's WhatsApp credentials.

**Credentials are AES-256-GCM sealed** with a fresh IV per write. A database
dump without `SESSION_ENCRYPTION_KEY` is inert. Reading a row written under a
different key raises rather than returning noise, so the failure is loud. In
development the key may be absent and values are stored with a marker instead —
`assertSafeBootConfig` makes sure that state can never reach production.

**Unlinking deletes the credential rows**, not just the status. An "unlinked"
session that kept its creds would be a live WhatsApp login the subscriber
believes they revoked.

**`force row level security` is set on every tenant table**, so a future job
connecting as the table owner does not quietly become tenant-blind.

**`set local` unwinds with the transaction**, so a pooled connection cannot leak
one request's claims into the next.

**Rotating the encryption key logs everyone out.** There is no re-wrap path.
That is deliberate: the alternative keeps both keys live during a migration,
doubling the window in which either leaking is fatal.

## Testing

```bash
createdb wafilter_test
cd api
DATABASE_URL=postgres://…/wafilter_test npm run test:migrate
DATABASE_URL=postgres://…/wafilter_test npm test
npm run typecheck
```

Test files share one database and truncate between cases, so they run
`--test-concurrency=1`. Running them in parallel turns the whole suite red in a
way that looks like a code failure and is not.

| File | Covers |
|---|---|
| `phone.test.ts` | JID parsing, normalisation, longest-prefix matching, order independence |
| `decide.test.ts` | The verdict, both policies, and the arming gate as a property over every settings combination |
| `rls.test.ts` | Tenant isolation, credential unreachability, what a subscriber may and may not write |
| `api.test.ts` | Every route, including the pairing flow and expiry |
| `worker.test.ts` | Credential encryption and round-tripping, the auth-state store, the held-action queue, retention |
| `integration.test.ts` | Rules stored through the API driving the real matcher — the seam the other files each miss |

## Troubleshooting

**"permission denied to create role" during migration.** The migration role
needs `BYPASSRLS`: `alter role app bypassrls`.

**"could not grant the app roles to …" notice.** Harmless on Supabase, where the
roles belong to someone else. On a plain Postgres it means `set local role` will
fail — grant them by hand with `grant authenticated, service_role to app with
inherit false, set true`.

**A newly linked account filters nothing.** Contacts have not synced, so every
sender reads as unknown, and history sync is off, so only new messages are seen.

**Numbers you blocked show `no_match`.** Check the prefix is in dialled form.
`917` is not the New York area code; `1917` is.

**A pending delete vanished without happening.** Either it was cancelled, or the
account was disarmed during the delay — the sweep re-checks and drops the action
with a `would_block` row saying so.

**`pairing failed: …` in `last_disconnect_reason`.** WhatsApp refused to issue a
code. Usually a wrong number or rate limiting; waiting and retrying is the only
remedy.

**A country you expected to be blocked is not, on a fresh account.** Only the 23
starter prefixes are seeded, and seven countries are deliberately left reachable
— see [What a new account starts with](#what-a-new-account-starts-with). Add the
rest yourself. And check it is not one a
subscriber deleted — deletions are permanent by design.

**A steady stream of `unresolved_jid`.** Those contacts are identified by `@lid`
handles with no number in them, so no rule can be evaluated. The filter is
quietly not covering them.

## Before you point this at a real number

- **Pair a throwaway number first and leave it disarmed for a day.** The
  activity log is the product's own proof that the rules are right, and it costs
  nothing to read before anything is irreversible.
- **WhatsApp's terms do not contemplate unofficial clients.** Baileys is one.
  Accounts have been banned for automated behaviour. This service only reads and
  acts on chats and never sends, which is the least provocative shape available,
  but the risk is real and it is the subscriber's account. If that is
  unacceptable, the WhatsApp Business API is the supported path — with a
  different product shape, because it is a separate number.
- **Deleting is not undoable.** The delay and the arming switch exist because of
  that, and the default two minutes is short. Consider raising it while a list is
  new.
- **Tell subscribers what a linked device can see.** It is their whole message
  stream. This service stores none of it, and the code is arranged so a future
  route cannot start to by accident, but the trust being asked for is real.

## Outstanding work

- **An identity provider behind `AUTH_MODE=external`.** `dev` mints a session
  from an email alone; production refuses to boot with it.
- **Resolving `@lid` JIDs to phone numbers**, so LID-only contacts can be
  filtered rather than logged as unreadable.
- **A worker lease**, so more than one worker can run. See
  [Scaling](#scaling-past-one-worker).
- **Billing.** `accounts.plan` exists and nothing reads it.
- **A narrower erasure path.** `filter_events` cascades from `accounts`, so
  deleting an account covers it, but there is no verb for "erase my activity and
  keep my account".
- **Rate limiting on signup and linking.** Neither is currently throttled.
