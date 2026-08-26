/** The routes, driven the way the dashboard drives them. */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { asService, many, one } from "../src/lib/db.ts";
import { authHeader, buildTestApp, clearRules, closeAll, createSubject, linkSession, resetDatabase } from "./helpers.ts";
import { activeRules } from "../src/domain/rules.ts";
import { getSettings, toSettings } from "../src/domain/accounts.ts";
import { decide } from "../src/domain/decide.ts";
import type { Subject } from "./helpers.ts";

type App = Awaited<ReturnType<typeof buildTestApp>>;

let app: App;
let alice: Subject;

before(async () => {
  await resetDatabase();
  app = await buildTestApp();
  await app.ready();
});

beforeEach(async () => {
  await resetDatabase();
  alice = await createSubject();
});

after(async () => {
  await app.close();
  await closeAll();
});

const json = (response: { body: string }) => JSON.parse(response.body);

/** Every new account is seeded with these; see db/migrations/0006_starter_rules.sql. */
const STARTER_RULES = 29;

describe("signup", () => {
  test("creates an account, settings and a usable token in one call", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/signup",
      payload: { email: "New.Person@Example.test" },
    });
    assert.equal(response.statusCode, 200);
    const body = json(response);
    assert.equal(body.email, "new.person@example.test", "the address is normalised");
    assert.ok(body.token);

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    assert.equal(me.statusCode, 200);
    const state = json(me);
    assert.equal(state.settings.armed, false, "an account is born disarmed");
    assert.equal(state.settings.action, "delete");
    assert.equal(state.settings.default_policy, "allow", "and as a block list, not an allow list");
    assert.equal(state.session, null);
  });

  test("signing up twice returns the same account rather than a second one", async () => {
    const first = json(await app.inject({ method: "POST", url: "/v1/signup", payload: { email: "dup@example.test" } }));
    const second = json(await app.inject({ method: "POST", url: "/v1/signup", payload: { email: "dup@example.test" } }));
    assert.equal(first.account_id, second.account_id);
  });

  test("a bad address is a 400, not a stack trace", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/signup", payload: { email: "nope" } });
    assert.equal(response.statusCode, 400);
    assert.equal(json(response).error, "bad_request");
  });

  test("no token means 401 everywhere it matters", async () => {
    for (const url of ["/v1/me", "/v1/rules", "/v1/activity", "/v1/settings", "/v1/link"]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 401, `${url} should require a session`);
    }
  });
});

describe("the starter block list", () => {
  test("a new account arrives with the list already loaded and labelled", async () => {
    const listed = json(await app.inject({ method: "GET", url: "/v1/rules", headers: authHeader(alice) }));
    assert.equal(listed.rules.length, 29);
    assert.ok(listed.rules.every((r: { kind: string }) => r.kind === "block"));
    assert.ok(listed.rules.every((r: { label: string | null }) => r.label));

    const byPrefix = new Map(listed.rules.map((r: { prefix: string; label: string }) => [r.prefix, r.label]));
    assert.equal(byPrefix.get("234"), "Nigeria");
    assert.equal(byPrefix.get("91"), "India");
    assert.equal(byPrefix.get("1876"), "Jamaica");
  });

  test("South Africa is not on it, and reaches an account that has it", async () => {
    const listed = json(await app.inject({ method: "GET", url: "/v1/rules", headers: authHeader(alice) }));
    assert.ok(
      !listed.rules.some((r: { prefix: string }) => r.prefix === "27"),
      "+27 must not be blocked",
    );

    const { rules, settings } = await alice.as(async (q) => ({
      rules: await activeRules(q, alice.accountId),
      settings: toSettings(await getSettings(q, alice.accountId)),
    }));
    const verdict = decide(
      { remoteJid: "27825550143@s.whatsapp.net", fromMe: false, isKnownContact: false },
      rules,
      { ...settings, armed: true },
    );
    assert.equal(verdict.decision, "no_match", "a South African number is untouched");
  });

  test("the starter list is still born disarmed, so it acts on nothing", async () => {
    const me = json(await app.inject({ method: "GET", url: "/v1/me", headers: authHeader(alice) }));
    assert.equal(me.settings.armed, false);

    const { rules, settings } = await alice.as(async (q) => ({
      rules: await activeRules(q, alice.accountId),
      settings: toSettings(await getSettings(q, alice.accountId)),
    }));
    const verdict = decide(
      { remoteJid: "2349015550111@s.whatsapp.net", fromMe: false, isKnownContact: false },
      rules,
      settings,
    );
    assert.equal(verdict.decision, "would_block");
    assert.equal(verdict.action, "log_only");
  });

  test("a deleted starter rule stays deleted", async () => {
    const listed = json(await app.inject({ method: "GET", url: "/v1/rules", headers: authHeader(alice) }));
    const nigeria = listed.rules.find((r: { prefix: string }) => r.prefix === "234");

    await app.inject({ method: "DELETE", url: `/v1/rules/${nigeria.id}`, headers: authHeader(alice) });

    // Signing up again with the same email must not resurrect it.
    await app.inject({ method: "POST", url: "/v1/signup", payload: { email: alice.email } });
    const after = json(await app.inject({ method: "GET", url: "/v1/rules", headers: authHeader(alice) }));
    assert.ok(!after.rules.some((r: { prefix: string }) => r.prefix === "234"));
    assert.equal(after.rules.length, 28);
  });
});

describe("rules", () => {
  // Rule CRUD is clearest against an account holding only what the test put there.
  beforeEach(() => clearRules(alice.accountId));

  test("a country code is stored with the name from the dial plan", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/rules",
      headers: authHeader(alice),
      payload: { prefix: "+234" },
    });
    assert.equal(response.statusCode, 201);
    const rule = json(response).rule;
    assert.equal(rule.prefix, "234");
    assert.equal(rule.kind, "block");
    assert.equal(rule.label, "Nigeria", "labelled without the caller having to know");
  });

  test("a bare area code needs the area_code flag to mean the area code", async () => {
    const asPrefix = json(
      await app.inject({
        method: "POST", url: "/v1/rules", headers: authHeader(alice),
        payload: { prefix: "917" },
      }),
    ).rule;
    assert.equal(asPrefix.prefix, "917", "taken literally by default");

    const asArea = json(
      await app.inject({
        method: "POST", url: "/v1/rules", headers: authHeader(alice),
        payload: { prefix: "917", area_code: true },
      }),
    ).rule;
    assert.equal(asArea.prefix, "1917");
    assert.equal(asArea.label, "New York");
  });

  test("the same prefix twice is a 409, not a duplicate row", async () => {
    await app.inject({ method: "POST", url: "/v1/rules", headers: authHeader(alice), payload: { prefix: "234" } });
    const again = await app.inject({
      method: "POST", url: "/v1/rules", headers: authHeader(alice), payload: { prefix: "234" },
    });
    assert.equal(again.statusCode, 409);
    assert.equal(json(again).error, "duplicate_prefix");
  });

  test("a bulk add reports what it skipped instead of failing the batch", async () => {
    await app.inject({ method: "POST", url: "/v1/rules", headers: authHeader(alice), payload: { prefix: "234" } });
    const response = await app.inject({
      method: "POST",
      url: "/v1/rules/bulk",
      headers: authHeader(alice),
      payload: { prefixes: ["234", "91", "92", "91"] },
    });
    assert.equal(response.statusCode, 200);
    const body = json(response);
    assert.deepEqual(body.created.map((r: { prefix: string }) => r.prefix).sort(), ["91", "92"]);
    assert.deepEqual(body.skipped, ["234"]);

    const listed = json(await app.inject({ method: "GET", url: "/v1/rules", headers: authHeader(alice) }));
    assert.equal(listed.rules.length, 3);
  });

  test("nonsense prefixes are rejected before they reach the database", async () => {
    for (const prefix of ["", "abc", "0123", "1234567890123456"]) {
      const response = await app.inject({
        method: "POST", url: "/v1/rules", headers: authHeader(alice), payload: { prefix },
      });
      assert.ok(response.statusCode === 400, `"${prefix}" should be rejected, got ${response.statusCode}`);
    }
  });

  test("rules can be switched off without being deleted, and then deleted", async () => {
    const rule = json(
      await app.inject({ method: "POST", url: "/v1/rules", headers: authHeader(alice), payload: { prefix: "234" } }),
    ).rule;

    const patched = await app.inject({
      method: "PATCH", url: `/v1/rules/${rule.id}`, headers: authHeader(alice), payload: { enabled: false },
    });
    assert.equal(json(patched).rule.enabled, false);

    const removed = await app.inject({
      method: "DELETE", url: `/v1/rules/${rule.id}`, headers: authHeader(alice),
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(
      json(await app.inject({ method: "GET", url: "/v1/rules", headers: authHeader(alice) })).rules.length,
      0,
    );
  });
});

describe("settings and arming", () => {
  test("arming stamps a time the caller did not supply", async () => {
    const before = json(await app.inject({ method: "GET", url: "/v1/settings", headers: authHeader(alice) }));
    assert.equal(before.settings.armed, false);
    assert.equal(before.settings.armed_at, null);

    const armed = json(
      await app.inject({
        method: "PATCH", url: "/v1/settings", headers: authHeader(alice), payload: { armed: true },
      }),
    );
    assert.equal(armed.settings.armed, true);
    assert.ok(armed.settings.armed_at, "stamped by the database");

    const disarmed = json(
      await app.inject({
        method: "PATCH", url: "/v1/settings", headers: authHeader(alice), payload: { armed: false },
      }),
    );
    assert.equal(disarmed.settings.armed_at, null, "and cleared on the way back down");
  });

  test("the delete delay is bounded", async () => {
    const tooLong = await app.inject({
      method: "PATCH", url: "/v1/settings", headers: authHeader(alice),
      payload: { delete_delay_seconds: 999999 },
    });
    assert.equal(tooLong.statusCode, 400);

    const ok = await app.inject({
      method: "PATCH", url: "/v1/settings", headers: authHeader(alice),
      payload: { delete_delay_seconds: 600 },
    });
    assert.equal(json(ok).settings.delete_delay_seconds, 600);
  });
});

describe("allowlist mode over the API", () => {
  test("the policy can be switched and comes back in every settings response", async () => {
    const patched = JSON.parse(
      (await app.inject({
        method: "PATCH", url: "/v1/settings", headers: authHeader(alice),
        payload: { default_policy: "block" },
      })).body,
    );
    assert.equal(patched.settings.default_policy, "block");

    const me = JSON.parse(
      (await app.inject({ method: "GET", url: "/v1/me", headers: authHeader(alice) })).body,
    );
    assert.equal(me.settings.default_policy, "block");
  });

  test("switching the policy leaves every other setting alone", async () => {
    await app.inject({
      method: "PATCH", url: "/v1/settings", headers: authHeader(alice),
      payload: { action: "archive", delete_delay_seconds: 300, apply_to_groups: true },
    });
    const after = JSON.parse(
      (await app.inject({
        method: "PATCH", url: "/v1/settings", headers: authHeader(alice),
        payload: { default_policy: "block" },
      })).body,
    ).settings;
    assert.equal(after.action, "archive");
    assert.equal(after.delete_delay_seconds, 300);
    assert.equal(after.apply_to_groups, true);
    assert.equal(after.armed, false, "and does not arm anything by itself");
  });

  test("only allow and block are accepted", async () => {
    const response = await app.inject({
      method: "PATCH", url: "/v1/settings", headers: authHeader(alice),
      payload: { default_policy: "deny" },
    });
    assert.equal(response.statusCode, 400);
  });
});

describe("linking", () => {
  test("a link request stores the number and reports no code yet", async () => {
    const response = await app.inject({
      method: "POST", url: "/v1/link", headers: authHeader(alice),
      payload: { phone: "+1 (555) 123-0000" },
    });
    assert.equal(response.statusCode, 200);
    const body = json(response);
    assert.equal(body.phone_e164, "15551230000");
    assert.equal(body.status, "pairing");
    assert.equal(body.pairing_code, null, "the worker has not been asked yet");
  });

  test("an unusable number never reaches the session table", async () => {
    const response = await app.inject({
      method: "POST", url: "/v1/link", headers: authHeader(alice), payload: { phone: "12345" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(json(response).error, "invalid_phone");
    assert.equal((await asService((q) => many(q, "select * from sessions"))).length, 0);
  });

  test("the pairing screen sees a code once the worker writes one, and not after it expires", async () => {
    await app.inject({
      method: "POST", url: "/v1/link", headers: authHeader(alice), payload: { phone: "15551230000" },
    });
    await asService((q) =>
      q.query(
        `update sessions set pairing_code = 'ABCD1234', pairing_expires_at = now() + interval '3 minutes'
          where account_id = $1`,
        [alice.accountId],
      ),
    );
    assert.equal(
      json(await app.inject({ method: "GET", url: "/v1/link", headers: authHeader(alice) })).pairing_code,
      "ABCD1234",
    );

    await asService((q) =>
      q.query(`update sessions set pairing_expires_at = now() - interval '1 second' where account_id = $1`, [
        alice.accountId,
      ]),
    );
    assert.equal(
      json(await app.inject({ method: "GET", url: "/v1/link", headers: authHeader(alice) })).pairing_code,
      null,
      "an expired code is never shown",
    );
  });

  test("re-requesting a link while pairing resets rather than erroring", async () => {
    await app.inject({ method: "POST", url: "/v1/link", headers: authHeader(alice), payload: { phone: "15551230000" } });
    const again = await app.inject({
      method: "POST", url: "/v1/link", headers: authHeader(alice), payload: { phone: "15551230001" },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(json(again).phone_e164, "15551230001");
    assert.equal((await asService((q) => many(q, "select * from sessions"))).length, 1);
  });

  test("linking a second number over a live link is refused", async () => {
    await linkSession(alice.accountId, "15551230000");
    const response = await app.inject({
      method: "POST", url: "/v1/link", headers: authHeader(alice), payload: { phone: "15551239999" },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(json(response).error, "already_linked");
  });

  test("unlinking destroys the credentials, not just the status", async () => {
    const sessionId = await linkSession(alice.accountId, "15551230000");
    await asService((q) =>
      q.query(
        `insert into session_auth_state (session_id, key, ciphertext, iv, auth_tag)
         values ($1,'creds','\\x00','\\x00','\\x00')`,
        [sessionId],
      ),
    );

    const response = await app.inject({ method: "DELETE", url: "/v1/link", headers: authHeader(alice) });
    assert.equal(response.statusCode, 200);

    const creds = await asService((q) => many(q, "select * from session_auth_state where session_id = $1", [sessionId]));
    assert.equal(creds.length, 0, "an unlinked session must not leave a working login behind");

    const session = await asService((q) =>
      one<{ status: string }>(q, "select status from sessions where id = $1", [sessionId]),
    );
    assert.equal(session?.status, "revoked");
  });
});

describe("activity", () => {
  test("the log reads back newest first with a summary beside it", async () => {
    const sessionId = await linkSession(alice.accountId, "15551230000");
    await asService(async (q) => {
      for (const [jid, decision] of [
        ["2349015550111@s.whatsapp.net", "would_block"],
        ["2349015550112@s.whatsapp.net", "blocked"],
        ["19175550123@s.whatsapp.net", "no_match"],
      ] as const) {
        await q.query(
          `insert into filter_events (account_id, session_id, remote_jid, decision) values ($1,$2,$3,$4)`,
          [alice.accountId, sessionId, jid, decision],
        );
      }
    });

    const body = json(await app.inject({ method: "GET", url: "/v1/activity", headers: authHeader(alice) }));
    assert.equal(body.events.length, 3);
    assert.equal(body.summary.blocked, 1);
    assert.equal(body.summary.would_block, 1);
    assert.equal(body.summary.no_match, 1);

    const filtered = json(
      await app.inject({ method: "GET", url: "/v1/activity?decision=blocked", headers: authHeader(alice) }),
    );
    assert.equal(filtered.events.length, 1);
  });

  test("a held delete can be seen and cancelled before it happens", async () => {
    const sessionId = await linkSession(alice.accountId, "15551230000");
    await asService((q) =>
      q.query(
        `insert into pending_actions (account_id, session_id, remote_jid, action, last_message, due_at)
         values ($1,$2,'2349015550111@s.whatsapp.net','delete','{}'::jsonb, now() + interval '2 minutes')`,
        [alice.accountId, sessionId],
      ),
    );

    const listed = json(await app.inject({ method: "GET", url: "/v1/pending", headers: authHeader(alice) }));
    assert.equal(listed.pending.length, 1);
    assert.equal(listed.pending[0].action, "delete");

    const cancelled = await app.inject({
      method: "DELETE", url: `/v1/pending/${listed.pending[0].id}`, headers: authHeader(alice),
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(
      json(await app.inject({ method: "GET", url: "/v1/pending", headers: authHeader(alice) })).pending.length,
      0,
    );
  });
});

describe("the dial plan", () => {
  test("searching finds a country by name and an area code by digits", async () => {
    const byName = json(
      await app.inject({ method: "GET", url: "/v1/dial-prefixes?q=niger", headers: authHeader(alice) }),
    );
    const names = byName.prefixes.map((p: { name: string }) => p.name);
    assert.ok(names.includes("Nigeria"));
    assert.ok(names.includes("Niger"));

    const areas = json(
      await app.inject({ method: "GET", url: "/v1/dial-prefixes?kind=nanp_area&q=1917", headers: authHeader(alice) }),
    );
    assert.equal(areas.prefixes[0].prefix, "1917");
    assert.equal(areas.prefixes[0].name, "New York");
  });
});
