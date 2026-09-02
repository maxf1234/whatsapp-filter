import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decide, decideCall } from "../src/domain/decide.ts";
import type { AccountSettings, IncomingMessage } from "../src/domain/decide.ts";
import type { PrefixRule } from "../src/domain/phone.ts";

const NIGERIA: PrefixRule = { id: "r-ng", kind: "block", prefix: "234" };
const INDIA: PrefixRule = { id: "r-in", kind: "block", prefix: "91" };
const FRIEND: PrefixRule = { id: "r-friend", kind: "allow", prefix: "234803" };
const RULES = [NIGERIA, INDIA, FRIEND];

const settings = (patch: Partial<AccountSettings> = {}): AccountSettings => ({
  action: "delete",
  armed: true,
  defaultPolicy: "allow",
  deleteDelaySeconds: 120,
  applyToKnownContacts: false,
  applyToGroups: false,
  rejectCalls: true,
  ...patch,
});

const from = (jid: string, patch: Partial<IncomingMessage> = {}): IncomingMessage => ({
  remoteJid: jid,
  fromMe: false,
  isKnownContact: false,
  ...patch,
});

const NG = "2349015550111@s.whatsapp.net";
const NG_FRIEND = "2348035550199@s.whatsapp.net";
const US = "19175550123@s.whatsapp.net";

describe("the armed switch", () => {
  test("an unarmed account records what it would do and does nothing", () => {
    const verdict = decide(from(NG), RULES, settings({ armed: false }));
    assert.equal(verdict.decision, "would_block");
    assert.equal(verdict.action, "log_only");
    assert.equal(verdict.delaySeconds, 0);
    assert.equal(verdict.matchedPrefix, "234");
  });

  test("an armed account with action=log_only still does nothing", () => {
    const verdict = decide(from(NG), RULES, settings({ action: "log_only" }));
    assert.equal(verdict.decision, "would_block");
    assert.equal(verdict.action, "log_only");
  });

  test("no combination of settings makes an unarmed account delete", () => {
    for (const action of ["log_only", "archive", "delete", "block_and_delete"] as const) {
      for (const applyToGroups of [true, false]) {
        for (const applyToKnownContacts of [true, false]) {
          const verdict = decide(
            from(NG, { isKnownContact: true }),
            RULES,
            settings({ armed: false, action, applyToGroups, applyToKnownContacts }),
          );
          assert.notEqual(verdict.action, "delete");
          assert.notEqual(verdict.action, "block_and_delete");
          assert.notEqual(verdict.decision, "blocked");
        }
      }
    }
  });

  test("armed and set to delete, it blocks and asks for the delay", () => {
    const verdict = decide(from(NG), RULES, settings());
    assert.equal(verdict.decision, "blocked");
    assert.equal(verdict.action, "delete");
    assert.equal(verdict.delaySeconds, 120);
  });

  test("archiving is reversible, so it is not delayed", () => {
    const verdict = decide(from(NG), RULES, settings({ action: "archive" }));
    assert.equal(verdict.action, "archive");
    assert.equal(verdict.delaySeconds, 0);
  });
});

describe("what gets looked at", () => {
  test("our own messages are never acted on", () => {
    const verdict = decide(from(NG, { fromMe: true }), RULES, settings());
    assert.equal(verdict.decision, "skipped_self");
  });

  test("groups are left alone unless the account opted in", () => {
    const group = from("120363000000000000@g.us", { participantJid: NG });
    assert.equal(decide(group, RULES, settings()).decision, "skipped_group");

    const opted = decide(group, RULES, settings({ applyToGroups: true }));
    assert.equal(opted.decision, "blocked", "the participant's number is what is judged");
    assert.equal(opted.matchedPrefix, "234");
    assert.ok(opted.isGroup);
  });

  test("a saved contact is exempt by default and can be opted back in", () => {
    const known = from(NG, { isKnownContact: true });
    assert.equal(decide(known, RULES, settings()).decision, "skipped_known");
    assert.equal(
      decide(known, RULES, settings({ applyToKnownContacts: true })).decision,
      "blocked",
    );
  });

  test("a LID is recorded as unresolved rather than passed off as a miss", () => {
    const verdict = decide(from("98765432101234@lid"), RULES, settings());
    assert.equal(verdict.decision, "unresolved_jid");
    assert.equal(verdict.detail, "lid");
    assert.equal(verdict.action, "log_only");
  });

  test("status broadcasts are not conversations", () => {
    assert.equal(decide(from("status@broadcast"), RULES, settings()).decision, "skipped_self");
  });
});

describe("rules", () => {
  test("an unmatched number passes", () => {
    const verdict = decide(from(US), RULES, settings());
    assert.equal(verdict.decision, "no_match");
    assert.equal(verdict.phone, "19175550123");
  });

  test("a longer allow rule rescues one number inside a blocked country", () => {
    const verdict = decide(from(NG_FRIEND), RULES, settings());
    assert.equal(verdict.decision, "allowed");
    assert.equal(verdict.matchedPrefix, "234803");
  });

  test("an area code rule matches only that area code", () => {
    const areaRules: PrefixRule[] = [{ id: "r-917", kind: "block", prefix: "1917" }];
    assert.equal(decide(from(US), areaRules, settings()).decision, "blocked");
    assert.equal(
      decide(from("12125550123@s.whatsapp.net"), areaRules, settings()).decision,
      "no_match",
    );
  });

  test("an empty rule set blocks nothing", () => {
    assert.equal(decide(from(NG), [], settings()).decision, "no_match");
  });
});

describe("calls", () => {
  test("a call from a blocked prefix is rejected without waiting on a delay", () => {
    const outcome = decideCall(NG, RULES, settings());
    assert.ok(outcome.reject);
    assert.equal(outcome.matchedPrefix, "234");
  });

  test("the allow exception applies to calls too", () => {
    assert.equal(decideCall(NG_FRIEND, RULES, settings()).reject, false);
  });

  test("rejection can be switched off, and is skipped for unmatched callers", () => {
    assert.equal(decideCall(NG, RULES, settings({ rejectCalls: false })).reject, false);
    assert.equal(decideCall(US, RULES, settings()).reject, false);
  });

  test("call rejection does not need the account armed, because it destroys nothing", () => {
    assert.ok(decideCall(NG, RULES, settings({ armed: false })).reject);
  });
});

describe("allowlist mode (default_policy = block)", () => {
  // "Block everything except South Africa" — one allow rule, and the policy.
  const ONLY_ZA: PrefixRule[] = [{ id: "r-za", kind: "allow", prefix: "27" }];
  const allowlist = (patch: Partial<AccountSettings> = {}) =>
    settings({ defaultPolicy: "block", ...patch });

  const ZA = "27825550143@s.whatsapp.net";

  test("the one allowed country gets through", () => {
    const verdict = decide(from(ZA), ONLY_ZA, allowlist());
    assert.equal(verdict.decision, "allowed");
    assert.equal(verdict.matchedPrefix, "27");
  });

  test("everything else is caught, including numbers no rule mentions", () => {
    for (const number of [NG, US, "919876543210@s.whatsapp.net", "4915555550123@s.whatsapp.net"]) {
      const verdict = decide(from(number), ONLY_ZA, allowlist());
      assert.equal(verdict.decision, "blocked", `${number} should be caught`);
      assert.equal(verdict.action, "delete");
    }
  });

  test("a caught number with no rule says why, so the log is explicable", () => {
    const verdict = decide(from(US), ONLY_ZA, allowlist());
    assert.equal(verdict.matchedPrefix, undefined);
    assert.equal(verdict.detail, "no rule matched; default policy is block");
  });

  test("the arming gate still holds — an allowlist account touches nothing until armed", () => {
    for (const action of ["log_only", "archive", "delete", "block_and_delete"] as const) {
      const verdict = decide(from(US), ONLY_ZA, allowlist({ armed: false, action }));
      assert.equal(verdict.decision, "would_block");
      assert.equal(verdict.action, "log_only");
    }
  });

  test("saved contacts still pass, which is the safety valve that makes this survivable", () => {
    const verdict = decide(from(US, { isKnownContact: true }), ONLY_ZA, allowlist());
    assert.equal(verdict.decision, "skipped_known");
  });

  test("your own messages are still never touched", () => {
    assert.equal(decide(from(US, { fromMe: true }), ONLY_ZA, allowlist()).decision, "skipped_self");
  });

  test("groups are still opt-in", () => {
    const group = from("120363000000000000@g.us", { participantJid: US });
    assert.equal(decide(group, ONLY_ZA, allowlist()).decision, "skipped_group");
    assert.equal(decide(group, ONLY_ZA, allowlist({ applyToGroups: true })).decision, "blocked");
  });

  test("a block rule inside an allowed country still wins by being longer", () => {
    const rules: PrefixRule[] = [...ONLY_ZA, { id: "r-za-spam", kind: "block", prefix: "27860" }];
    assert.equal(decide(from(ZA), rules, allowlist()).decision, "allowed");
    assert.equal(
      decide(from("27860555012@s.whatsapp.net"), rules, allowlist()).decision,
      "blocked",
    );
  });

  test("an allowlist with no allow rules catches everything, which is what it says", () => {
    assert.equal(decide(from(ZA), [], allowlist()).decision, "blocked");
  });

  test("switching the policy back to allow restores blocklist behaviour exactly", () => {
    assert.equal(decide(from(US), ONLY_ZA, settings()).decision, "no_match");
  });

  test("calls follow the same policy", () => {
    assert.equal(decideCall(ZA, ONLY_ZA, allowlist()).reject, false);
    assert.ok(decideCall(US, ONLY_ZA, allowlist()).reject);
    assert.equal(decideCall(US, ONLY_ZA, settings()).reject, false, "blocklist mode lets it ring");
  });

  test("an unreadable caller is never rejected, since there is no way to allow one", () => {
    assert.equal(decideCall("98765432101234@lid", ONLY_ZA, allowlist()).reject, false);
  });

  test("a LID message is still logged rather than caught by the default", () => {
    const verdict = decide(from("98765432101234@lid"), ONLY_ZA, allowlist());
    assert.equal(verdict.decision, "unresolved_jid");
    assert.equal(verdict.action, "log_only");
  });
});
