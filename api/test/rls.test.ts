/**
 * The file that matters most here.
 *
 * The application never filters by account_id — it publishes claims and lets
 * RLS decide. That is only safe if RLS actually decides, so these assert the
 * boundary directly rather than through the routes that rely on it.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { asPrincipal, asService, many, one } from "../src/lib/db.ts";
import { closeAll, createSubject, linkSession, resetDatabase } from "./helpers.ts";
import type { Subject } from "./helpers.ts";
import { createRule } from "../src/domain/rules.ts";

let alice: Subject;
let mallory: Subject;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  alice = await createSubject();
  mallory = await createSubject();
});

after(closeAll);

describe("tenant isolation", () => {
  test("one subscriber cannot see another's rules", async () => {
    await alice.as((q) => createRule(q, alice.accountId, { kind: "block", prefix: "234" }));

    const mine = await alice.as((q) => many(q, "select * from rules"));
    assert.equal(mine.length, 1);

    const theirs = await mallory.as((q) => many(q, "select * from rules"));
    assert.equal(theirs.length, 0, "an unfiltered select still returns nothing");
  });

  test("a subscriber cannot write a rule onto someone else's account", async () => {
    await assert.rejects(
      () =>
        mallory.as((q) =>
          q.query(`insert into rules (account_id, kind, prefix) values ($1,'block','234')`, [
            alice.accountId,
          ]),
        ),
      /row-level security/i,
    );
  });

  test("naming another account's rule id does not reach it", async () => {
    const rule = await alice.as((q) =>
      createRule(q, alice.accountId, { kind: "block", prefix: "234" }),
    );

    const updated = await mallory.as((q) =>
      q.query(`update rules set enabled = false where id = $1`, [rule.id]),
    );
    assert.equal(updated.rowCount, 0);

    const deleted = await mallory.as((q) =>
      q.query(`delete from rules where id = $1`, [rule.id]),
    );
    assert.equal(deleted.rowCount, 0);

    const still = await alice.as((q) => one(q, `select enabled from rules where id = $1`, [rule.id]));
    assert.equal((still as { enabled: boolean }).enabled, true, "alice's rule is untouched");
  });

  test("activity is visible to its owner and to nobody else", async () => {
    const sessionId = await linkSession(alice.accountId, "15551230000");
    await asService((q) =>
      q.query(
        `insert into filter_events (account_id, session_id, remote_jid, phone_e164, decision)
         values ($1,$2,'2349015550111@s.whatsapp.net','2349015550111','blocked')`,
        [alice.accountId, sessionId],
      ),
    );

    assert.equal((await alice.as((q) => many(q, "select * from filter_events"))).length, 1);
    assert.equal((await mallory.as((q) => many(q, "select * from filter_events"))).length, 0);
  });

  test("settings cannot be flipped on another account", async () => {
    const changed = await mallory.as((q) =>
      q.query(`update account_settings set armed = true where account_id = $1`, [alice.accountId]),
    );
    assert.equal(changed.rowCount, 0);

    const settings = await alice.as((q) =>
      one<{ armed: boolean }>(q, `select armed from account_settings where account_id = $1`, [
        alice.accountId,
      ]),
    );
    assert.equal(settings?.armed, false);
  });
});

describe("credentials", () => {
  test("no subscriber can read session_auth_state, not even their own", async () => {
    const sessionId = await linkSession(alice.accountId, "15551230000");
    await asService((q) =>
      q.query(
        `insert into session_auth_state (session_id, key, ciphertext, iv, auth_tag)
         values ($1, 'creds', '\\x00', '\\x00', '\\x00')`,
        [sessionId],
      ),
    );

    // The table has RLS on and no permissive policy, so the grant is missing too:
    // the failure is a permission error rather than an empty result, and either
    // way the row is unreachable.
    await assert.rejects(
      () => alice.as((q) => many(q, "select * from session_auth_state")),
      /permission denied/i,
    );

    const asWorker = await asService((q) => many(q, "select * from session_auth_state"));
    assert.equal(asWorker.length, 1, "the worker can still read what it needs");
  });

  test("a subscriber cannot rewrite their session row to point at another number", async () => {
    const sessionId = await linkSession(alice.accountId, "15551230000");
    await assert.rejects(
      () =>
        alice.as((q) =>
          q.query(`update sessions set phone_e164 = '9990000000' where id = $1`, [sessionId]),
        ),
      /permission denied/i,
    );
  });
});

describe("the pending queue", () => {
  test("a subscriber can cancel their own held action but not create one", async () => {
    const sessionId = await linkSession(alice.accountId, "15551230000");
    const pending = await asService((q) =>
      one<{ id: string }>(
        q,
        `insert into pending_actions (account_id, session_id, remote_jid, action, last_message, due_at)
         values ($1,$2,'2349015550111@s.whatsapp.net','delete','{}'::jsonb, now() + interval '2 minutes')
         returning id`,
        [alice.accountId, sessionId],
      ),
    );

    await assert.rejects(
      () =>
        alice.as((q) =>
          q.query(
            `insert into pending_actions (account_id, session_id, remote_jid, action, last_message, due_at)
             values ($1,$2,'x@s.whatsapp.net','delete','{}'::jsonb, now())`,
            [alice.accountId, sessionId],
          ),
        ),
      /permission denied/i,
    );

    assert.equal(
      (await mallory.as((q) => q.query(`delete from pending_actions where id = $1`, [pending!.id])))
        .rowCount,
      0,
      "and not someone else's",
    );

    const cancelled = await alice.as((q) =>
      q.query(`delete from pending_actions where id = $1`, [pending!.id]),
    );
    assert.equal(cancelled.rowCount, 1);
  });
});

describe("claims", () => {
  test("a request with no claims sees nothing at all", async () => {
    await alice.as((q) => createRule(q, alice.accountId, { kind: "block", prefix: "234" }));
    const rows = await asPrincipal({ sub: "00000000-0000-0000-0000-000000000000" }, (q) =>
      many(q, "select * from rules"),
    );
    assert.equal(rows.length, 0);
  });
});
