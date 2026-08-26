/**
 * The seam between the two halves that are tested separately elsewhere: rules
 * as they come out of Postgres, fed to the matcher as the worker feeds them.
 *
 * decide.test.ts proves the logic against hand-written rules; api.test.ts proves
 * the routes store what was asked for. Neither would catch a mismatch between
 * the two — a column renamed, a kind stored as text where the matcher expects an
 * enum — which is exactly the failure that would quietly stop the filter working.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { authHeader, buildTestApp, clearRules, closeAll, createSubject, resetDatabase } from "./helpers.ts";
import type { Subject } from "./helpers.ts";
import { activeRules } from "../src/domain/rules.ts";
import { getSettings, toSettings, updateSettings } from "../src/domain/accounts.ts";
import { decide, decideCall } from "../src/domain/decide.ts";

type App = Awaited<ReturnType<typeof buildTestApp>>;

let app: App;
let alice: Subject;

const jid = (digits: string) => `${digits}@s.whatsapp.net`;
const arriving = (digits: string) => ({
  remoteJid: jid(digits),
  fromMe: false,
  isKnownContact: false,
});

before(async () => {
  await resetDatabase();
  app = await buildTestApp();
  await app.ready();
});

beforeEach(async () => {
  await resetDatabase();
  alice = await createSubject();
  // This file asserts on an exact rule set, so it starts from empty.
  await clearRules(alice.accountId);

  // Built through the API, exactly as the dashboard would.
  await app.inject({
    method: "POST", url: "/v1/rules/bulk", headers: authHeader(alice),
    payload: { prefixes: ["234", "91"], kind: "block" },
  });
  await app.inject({
    method: "POST", url: "/v1/rules", headers: authHeader(alice),
    payload: { prefix: "234803", kind: "allow" },
  });
  await app.inject({
    method: "POST", url: "/v1/rules", headers: authHeader(alice),
    payload: { prefix: "917", area_code: true },
  });
});

after(async () => {
  await app.close();
  await closeAll();
});

async function policy() {
  return alice.as(async (q) => ({
    rules: await activeRules(q, alice.accountId),
    settings: toSettings(await getSettings(q, alice.accountId)),
  }));
}

describe("rules stored through the API drive the matcher", () => {
  test("a fresh account watches and never acts", async () => {
    const { rules, settings } = await policy();
    const verdict = decide(arriving("2349015550111"), rules, settings);
    assert.equal(verdict.decision, "would_block");
    assert.equal(verdict.action, "log_only");
    assert.equal(verdict.matchedPrefix, "234");
  });

  test("once armed, the same message is acted on", async () => {
    await alice.as((q) => updateSettings(q, alice.accountId, { armed: true }));
    const { rules, settings } = await policy();
    const verdict = decide(arriving("2349015550111"), rules, settings);
    assert.equal(verdict.decision, "blocked");
    assert.equal(verdict.action, "delete");
    assert.equal(verdict.delaySeconds, 120);
  });

  test("the exception stored as a longer prefix wins over its country", async () => {
    await alice.as((q) => updateSettings(q, alice.accountId, { armed: true }));
    const { rules, settings } = await policy();
    assert.equal(decide(arriving("2348035550199"), rules, settings).decision, "allowed");
  });

  test("the area code added as '917' matches 1-917 and nothing else", async () => {
    await alice.as((q) => updateSettings(q, alice.accountId, { armed: true }));
    const { rules, settings } = await policy();
    assert.equal(decide(arriving("19175550123"), rules, settings).decision, "blocked");
    assert.equal(decide(arriving("12125550123"), rules, settings).decision, "no_match");
  });

  test("disabling a rule takes it out of the matcher", async () => {
    await alice.as((q) => updateSettings(q, alice.accountId, { armed: true }));
    const listed = JSON.parse(
      (await app.inject({ method: "GET", url: "/v1/rules", headers: authHeader(alice) })).body,
    ).rules;
    const nigeria = listed.find((r: { prefix: string }) => r.prefix === "234");

    await app.inject({
      method: "PATCH", url: `/v1/rules/${nigeria.id}`, headers: authHeader(alice),
      payload: { enabled: false },
    });

    const { rules, settings } = await policy();
    assert.equal(decide(arriving("2349015550111"), rules, settings).decision, "no_match");
    assert.equal(
      decide(arriving("919876543210"), rules, settings).decision,
      "blocked",
      "the other rules are untouched",
    );
  });

  test("switching the action to archive changes what happens, not what matches", async () => {
    await alice.as((q) => updateSettings(q, alice.accountId, { armed: true, action: "archive" }));
    const { rules, settings } = await policy();
    const verdict = decide(arriving("2349015550111"), rules, settings);
    assert.equal(verdict.decision, "blocked");
    assert.equal(verdict.action, "archive");
    assert.equal(verdict.delaySeconds, 0);
  });

  test("calls are judged by the same stored rules", async () => {
    const { rules, settings } = await policy();
    assert.ok(decideCall(jid("2349015550111"), rules, settings).reject);
    assert.equal(decideCall(jid("2348035550199"), rules, settings).reject, false);
    assert.equal(decideCall(jid("15551230000"), rules, settings).reject, false);
  });

  test("allowlist mode, built through the API, catches everything but the allowed prefix", async () => {
    // Exactly the "block all except South Africa" shape, end to end.
    const solo = await createSubject();
    await clearRules(solo.accountId);
    await app.inject({
      method: "POST", url: "/v1/rules", headers: authHeader(solo),
      payload: { prefix: "27", kind: "allow" },
    });
    await app.inject({
      method: "PATCH", url: "/v1/settings", headers: authHeader(solo),
      payload: { default_policy: "block", armed: true },
    });

    const { rules, settings } = await solo.as(async (q) => ({
      rules: await activeRules(q, solo.accountId),
      settings: toSettings(await getSettings(q, solo.accountId)),
    }));

    assert.equal(settings.defaultPolicy, "block");
    assert.equal(decide(arriving("27825550143"), rules, settings).decision, "allowed");
    for (const number of ["19175550123", "2349015550111", "919876543210", "4915555550123"]) {
      assert.equal(
        decide(arriving(number), rules, settings).decision,
        "blocked",
        `+${number} should be caught`,
      );
    }
  });

  test("one account's rules never reach another's decisions", async () => {
    const mallory = await createSubject();
    await clearRules(mallory.accountId);
    const theirs = await mallory.as(async (q) => ({
      rules: await activeRules(q, mallory.accountId),
      settings: toSettings(await getSettings(q, mallory.accountId)),
    }));
    assert.equal(theirs.rules.length, 0);
    assert.equal(decide(arriving("2349015550111"), theirs.rules, theirs.settings).decision, "no_match");
  });
});
