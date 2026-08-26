# whatsapp-filter

A WhatsApp number filter as a service: subscribers sign up on a landing page,
pair their WhatsApp with an eight-character code, name the country codes and
area codes they never want to hear from, and matching conversations stop
arriving.

```
web/               Landing page, pairing screen and dashboard (vanilla, no build)
api/src/routes/    Fastify: signup, linking, rules, settings, activity
api/src/domain/    The filter itself — normalisation, matching, the decision
api/src/worker/    One supervised Baileys socket per account, and enforcement
db/migrations/     Schema, RLS policies, the dial-plan reference data
scripts/migrate.sh Migration runner
docs/              Architecture and the operational notes worth reading first
```

## Status

**Everything except the WhatsApp socket is built and tested.** 84 tests run
against a live Postgres 16, covering tenant isolation, the matcher, the arming
gate, the pairing flow, credential encryption, the held-action queue and
retention. The API, the dashboard and the database have been driven end to end.

**The Baileys socket has never been connected to a real WhatsApp account.**
Everything it hands off to — the auth-state store, the decision engine, the
queue — is tested, but pairing, the `messages.upsert` stream and `chatModify`
have not run against WhatsApp itself. Expect to spend the first session with a
throwaway number watching the log, and see [Before you point this at a real
number](#before-you-point-this-at-a-real-number).

## One idea does all the work

A rule is a leading-digit prefix on the full international number, and the
longest matching prefix wins.

| Rule      | Means                                                        |
|-----------|--------------------------------------------------------------|
| `234`     | all of Nigeria                                               |
| `91`      | all of India                                                 |
| `1917`    | the 917 area code — a NANP number is `1` + area code + 7 digits |
| `234803`  | as an *allow* rule, the one Lagos number you do talk to      |

That is why there is no separate "area code mode": an area code is a longer
country prefix. And it is why an exception needs no new concept — `234803` beats
`234` by being longer, so blocking a country and keeping one contact in it is
two rules, not a feature.

Ties cannot happen: the schema holds one verdict per `(account, prefix)`, so the
order rules load in never changes a decision. `api/test/decide.test.ts` asserts
that directly.

## The safety model

The action a subscriber asks for is **delete the conversation**, and WhatsApp
has no undo for it. Three things stand in front of that:

1. **Accounts are born disarmed.** `action` defaults to `delete` and `armed`
   defaults to `false`, and the pair means "watch". Matches are evaluated and
   written to the activity log as `would_block`; nothing is touched. There is no
   combination of settings that makes an unarmed account act — that is asserted
   as a property over every combination in `decide.test.ts`, not just the one
   path.
2. **Arming is deliberate and dated.** It is one switch, it names what will
   happen before it flips, and `armed_at` is stamped by the database rather than
   by the caller, so the log can always answer "was this account armed when that
   message arrived?"
3. **Deletes are held.** A match queues the action for `delete_delay_seconds`
   (two minutes by default) and shows it on the dashboard, where it can be
   cancelled. When the delay runs out the worker **re-checks the armed state**
   rather than trusting the decision it made two minutes ago, so disarming
   during the delay actually stops it.

Archiving is reversible and is not delayed. Call rejection destroys nothing and
so is not gated on arming at all.

## What the filter can and cannot see

**Group chats are off by default,** and when on, the number judged is the
individual participant's — a group has no country code of its own.

**Saved contacts are exempt by default.** Someone in the address book is someone
the subscriber chose to know, whatever their country code.

**A `@lid` JID has no number in it.** WhatsApp's newer linked-identity JIDs are
deliberately not phone numbers. Those are recorded as `unresolved_jid` rather
than passed off as "no match", so "the filter never fires on this contact" shows
up in the log instead of looking like a quiet pass. This is the most likely
thing to need work once it meets real traffic.

**Message content is never stored.** The activity log holds the number, the
matched prefix and the decision. `lib/logging.ts` redacts bodies at the
serialiser rather than at each call site, so a future route cannot log one by
forgetting.

## Security posture

The application never filters by `account_id`. It publishes JWT claims and lets
RLS decide, so a forgotten `WHERE` clause in a future route cannot show one
subscriber another's chats — `api/test/rls.test.ts` is the test file that
matters most here.

`session_auth_state` holds each subscriber's WhatsApp credentials. It has RLS on
and **no policy at all**, so `authenticated` sees nothing regardless of what it
asks for; only the worker's `service_role` can read it. The values are AES-256-GCM
sealed with `SESSION_ENCRYPTION_KEY`, so a database dump without the key is
inert. Unlinking deletes the credential rows rather than only flipping a status —
an "unlinked" session that kept its creds would be a live WhatsApp login the
subscriber believes they revoked.

## Running it

Postgres 16 and Node 22.

```bash
createdb wafilter_dev
DATABASE_URL=postgres://…/wafilter_dev ./scripts/migrate.sh

cd api
npm install
cp ../.env.example ../.env      # edit it
npm start
```

Then open http://localhost:8080.

The migration role needs `BYPASSRLS`, because it creates `service_role`, which
has it. On a plain Postgres: `alter role app bypassrls`. On Supabase the roles
already exist and the migration skips that block.

Tests need their own database:

```bash
createdb wafilter_test
cd api
DATABASE_URL=postgres://…/wafilter_test npm run test:migrate
DATABASE_URL=postgres://…/wafilter_test npm test
```

Test files share one database and truncate between cases, so they run
`--test-concurrency=1`. Running them in parallel turns the whole suite red in a
way that looks like a code failure and is not.

## Deploying

Baileys needs a long-lived process, which rules out pure serverless — but not a
persistent disk, because the credentials live in Postgres rather than on a
volume. That is what makes this multi-tenant: a replacement container picks up
every subscriber's link, and there is no per-session directory to lose on
redeploy.

`Dockerfile` and `railway.json` are set up for Railway with a Postgres plugin.
Set `DATABASE_URL`, `JWT_SECRET`, `SESSION_ENCRYPTION_KEY` and `NODE_ENV=production`;
the release command runs migrations. To split web from worker, run two services
off the same image with `RUN_WORKER=false` on the web one — exactly one
deployment should have it true, since two workers would each open a socket for
the same account.

## Before you point this at a real number

- **Pair a throwaway number first and leave it disarmed for a day.** The
  activity log is the product's own proof that the rules are right, and it costs
  nothing to read it before anything is irreversible.
- **WhatsApp's terms do not contemplate unofficial clients.** Baileys is one.
  Accounts have been banned for automated behaviour; this service only reads and
  acts on chats, never sends, which is the least provocative shape available,
  but the risk is real and it is the subscriber's account.
- **`shouldSyncHistoryMessage` is off.** Pulling a subscriber's history would
  mean holding years of their conversations in a process with no business seeing
  any of it. The cost is that the filter only sees messages arriving from the
  moment it links.
- **Contacts may not have synced when a session first connects,** so
  `isKnownContact` reads false until they do. The exemption therefore only ever
  adds safety once the sync lands, which is why `apply_to_known_contacts`
  defaults to off rather than relying on it.

## Outstanding

- An identity provider behind `AUTH_MODE=external`. `AUTH_MODE=dev` mints a
  session from an email alone and the service refuses to boot with it in
  production.
- Resolving `@lid` JIDs to phone numbers, so LID-only contacts can be filtered
  rather than logged as unreadable.
- Billing. `accounts.plan` exists and nothing reads it.
- A deletion path for a subscriber's activity on erasure request. `filter_events`
  cascades from `accounts`, so account deletion covers it, but there is no
  narrower verb.
