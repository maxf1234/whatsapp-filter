/**
 * The worker's persistence: credentials that survive a restart without being
 * readable from a database dump, and a queue that cannot act twice or act after
 * it has been told to stop.
 *
 * The socket itself is not exercised here — that needs a real WhatsApp account.
 * What is exercised is everything the socket hands off to.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { asService, many, one } from "../src/lib/db.ts";
import { closeAll, createSubject, linkSession, resetDatabase } from "./helpers.ts";
import type { Subject } from "./helpers.ts";
import { seal, open, resetKeyCache } from "../src/lib/crypto.ts";
import { useDbAuthState } from "../src/worker/dbAuthState.ts";
import {
  claimDuePending, enqueuePending, listPending, purgeOldEvents, recordEvent, requeuePending,
} from "../src/domain/activity.ts";

let alice: Subject;
let sessionId: string;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  alice = await createSubject();
  sessionId = await linkSession(alice.accountId, "15551230000");
});

after(closeAll);

describe("credential encryption", () => {
  test("a sealed value round-trips", () => {
    process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    resetKeyCache();
    try {
      const plaintext = Buffer.from(JSON.stringify({ noiseKey: "secret" }));
      const sealed = seal(plaintext);
      assert.ok(!sealed.ciphertext.equals(plaintext), "the stored bytes are not the plaintext");
      assert.deepEqual(open(sealed), plaintext);
    } finally {
      delete process.env.SESSION_ENCRYPTION_KEY;
      resetKeyCache();
    }
  });

  test("a tampered ciphertext fails to open rather than yielding garbage", () => {
    process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    resetKeyCache();
    try {
      const sealed = seal(Buffer.from("creds"));
      sealed.ciphertext[0] = (sealed.ciphertext[0] ?? 0) ^ 0xff;
      assert.throws(() => open(sealed));
    } finally {
      delete process.env.SESSION_ENCRYPTION_KEY;
      resetKeyCache();
    }
  });

  test("a value sealed under one key cannot be opened with another", () => {
    process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    resetKeyCache();
    const sealed = seal(Buffer.from("creds"));
    process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    resetKeyCache();
    try {
      assert.throws(() => open(sealed));
    } finally {
      delete process.env.SESSION_ENCRYPTION_KEY;
      resetKeyCache();
    }
  });

  test("a rejected key length is caught at use rather than silently truncated", () => {
    process.env.SESSION_ENCRYPTION_KEY = "abcd";
    resetKeyCache();
    try {
      assert.throws(() => seal(Buffer.from("x")), /32 bytes/);
    } finally {
      delete process.env.SESSION_ENCRYPTION_KEY;
      resetKeyCache();
    }
  });
});

describe("the auth state store", () => {
  test("credentials survive being written and read back by a fresh worker", async () => {
    process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    resetKeyCache();
    try {
      const first = await useDbAuthState(sessionId);
      assert.equal(first.registered, false, "a new session has not paired yet");
      first.state.creds.registered = true;
      await first.saveCreds();

      // A different worker process starting on the same row.
      const second = await useDbAuthState(sessionId);
      assert.equal(second.registered, true);
      assert.equal(second.state.creds.registered, true);
    } finally {
      delete process.env.SESSION_ENCRYPTION_KEY;
      resetKeyCache();
    }
  });

  test("Buffers survive the JSON round trip Baileys depends on", async () => {
    process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    resetKeyCache();
    try {
      const auth = await useDbAuthState(sessionId);
      const original = auth.state.creds.noiseKey.private;
      await auth.saveCreds();

      const reloaded = await useDbAuthState(sessionId);
      const restored = reloaded.state.creds.noiseKey.private;
      assert.ok(Buffer.isBuffer(restored) || restored instanceof Uint8Array);
      assert.deepEqual(Buffer.from(restored), Buffer.from(original));
    } finally {
      delete process.env.SESSION_ENCRYPTION_KEY;
      resetKeyCache();
    }
  });

  test("signal keys are stored one row per key and removed when set to null", async () => {
    const auth = await useDbAuthState(sessionId);
    await auth.state.keys.set({
      "pre-key": { "1": { public: Buffer.from([1]), private: Buffer.from([2]) } as never },
    });
    assert.deepEqual(Object.keys(await auth.state.keys.get("pre-key", ["1"])), ["1"]);

    await auth.state.keys.set({ "pre-key": { "1": null as never } });
    assert.deepEqual(await auth.state.keys.get("pre-key", ["1"]), {});
  });

  test("what lands on disk is ciphertext, not the credentials", async () => {
    process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    resetKeyCache();
    try {
      const auth = await useDbAuthState(sessionId);
      await auth.saveCreds();
      const row = await asService((q) =>
        one<{ ciphertext: Buffer }>(
          q, `select ciphertext from session_auth_state where session_id = $1 and key = 'creds'`, [sessionId],
        ),
      );
      const bytes = row!.ciphertext.toString("utf8");
      assert.ok(!bytes.includes("noiseKey"), "a dump of this table gives up nothing");
      assert.ok(!bytes.includes("registered"));
    } finally {
      delete process.env.SESSION_ENCRYPTION_KEY;
      resetKeyCache();
    }
  });
});

describe("the pending queue", () => {
  const jid = "2349015550111@s.whatsapp.net";

  const enqueue = (delaySeconds: number) =>
    asService((q) =>
      enqueuePending(q, {
        accountId: alice.accountId,
        sessionId,
        remoteJid: jid,
        action: "delete",
        lastMessage: { key: { id: "abc", remoteJid: jid }, messageTimestamp: 1 },
        delaySeconds,
      }),
    );

  test("a held action is not claimable before it is due", async () => {
    await enqueue(120);
    assert.equal((await asService((q) => claimDuePending(q))).length, 0);
    assert.equal((await alice.as((q) => listPending(q, alice.accountId))).length, 1);
  });

  test("a due action is claimed exactly once", async () => {
    await enqueue(0);
    const first = await asService((q) => claimDuePending(q));
    assert.equal(first.length, 1);
    const second = await asService((q) => claimDuePending(q));
    assert.equal(second.length, 0, "claiming removes it, so a second worker gets nothing");
  });

  test("a flood from one chat refreshes the anchor but never moves the deadline", async () => {
    await enqueue(60);
    const firstDue = (await alice.as((q) => listPending(q, alice.accountId)))[0]!.due_at;

    for (let i = 0; i < 5; i++) {
      await asService((q) =>
        enqueuePending(q, {
          accountId: alice.accountId,
          sessionId,
          remoteJid: jid,
          action: "delete",
          lastMessage: { key: { id: `msg-${i}`, remoteJid: jid }, messageTimestamp: i },
          delaySeconds: 600,
        }),
      );
    }

    const rows = await alice.as((q) => listPending(q, alice.accountId));
    assert.equal(rows.length, 1, "one chat, one pending action");
    assert.equal(rows[0]!.due_at, firstDue, "a spammer cannot push their own deletion away");
    assert.equal(
      (rows[0]!.last_message as { key: { id: string } }).key.id,
      "msg-4",
      "but the anchor tracks the newest message",
    );
  });

  test("a retry counts attempts so a permanently failing action gives up", async () => {
    await enqueue(0);
    let row = (await asService((q) => claimDuePending(q)))[0]!;
    assert.equal(row.attempts, 0);

    await asService((q) => requeuePending(q, row, 0));
    row = (await asService((q) => claimDuePending(q)))[0]!;
    assert.equal(row.attempts, 1);
  });

  test("cancelling is all a subscriber needs to stop a delete", async () => {
    await enqueue(120);
    const pending = (await alice.as((q) => listPending(q, alice.accountId)))[0]!;
    await alice.as((q) => q.query(`delete from pending_actions where id = $1`, [pending.id]));
    assert.equal((await asService((q) => claimDuePending(q))).length, 0);
  });
});

describe("retention", () => {
  test("old activity is swept and recent activity is not", async () => {
    await asService(async (q) => {
      await recordEvent(q, {
        accountId: alice.accountId, sessionId, remoteJid: "a@s.whatsapp.net",
        verdict: { decision: "blocked", isGroup: false },
      });
      await recordEvent(q, {
        accountId: alice.accountId, sessionId, remoteJid: "b@s.whatsapp.net",
        verdict: { decision: "no_match", isGroup: false },
      });
      await q.query(
        `update filter_events set occurred_at = now() - interval '200 days'
          where remote_jid = 'a@s.whatsapp.net'`,
      );
    });

    const removed = await asService((q) => purgeOldEvents(q, 90));
    assert.equal(removed, 1);
    const left = await asService((q) => many(q, "select remote_jid from filter_events"));
    assert.deepEqual(left.map((r) => r.remote_jid), ["b@s.whatsapp.net"]);
  });
});
