import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  formatPhone, isConversationalJid, isGroupJid, isLidJid, matchPrefix,
  normalizePhone, parseJid, phoneFromJid,
} from "../src/domain/phone.ts";
import type { PrefixRule } from "../src/domain/phone.ts";

const rule = (prefix: string, kind: "block" | "allow" = "block"): PrefixRule => ({
  id: `rule-${kind}-${prefix}`,
  kind,
  prefix,
});

describe("parseJid", () => {
  test("strips the device and session suffixes WhatsApp appends", () => {
    assert.deepEqual(parseJid("15551234567:12@s.whatsapp.net"), {
      user: "15551234567",
      server: "s.whatsapp.net",
    });
    assert.deepEqual(parseJid("15551234567_1@s.whatsapp.net")?.user, "15551234567");
  });

  test("rejects anything without both halves", () => {
    assert.equal(parseJid("15551234567"), undefined);
    assert.equal(parseJid("@s.whatsapp.net"), undefined);
    assert.equal(parseJid("15551234567@"), undefined);
  });
});

describe("jid classification", () => {
  test("groups, lids and broadcasts are each recognised", () => {
    assert.ok(isGroupJid("120363000000000000@g.us"));
    assert.ok(!isGroupJid("15551234567@s.whatsapp.net"));
    assert.ok(isLidJid("98765432101234@lid"));
    assert.ok(!isConversationalJid("status@broadcast"));
    assert.ok(isConversationalJid("15551234567@s.whatsapp.net"));
  });
});

describe("normalizePhone", () => {
  test("accepts the shapes a person actually types", () => {
    assert.equal(normalizePhone("+1 (917) 555-0123"), "19175550123");
    assert.equal(normalizePhone("00234 803 555 0199"), "2348035550199");
    assert.equal(normalizePhone("011 91 98765 43210"), "919876543210");
    assert.equal(normalizePhone("15551234567@s.whatsapp.net"), "15551234567");
  });

  test("returns undefined rather than guessing at something implausible", () => {
    assert.equal(normalizePhone(""), undefined);
    assert.equal(normalizePhone("12345"), undefined, "too short to be international");
    assert.equal(normalizePhone("0123456789"), undefined, "leading zero is not E.164");
    assert.equal(normalizePhone("1234567890123456"), undefined, "longer than E.164 allows");
  });
});

describe("phoneFromJid", () => {
  test("reads a number out of a person's JID", () => {
    assert.equal(phoneFromJid("2348035550199@s.whatsapp.net"), "2348035550199");
  });

  test("refuses the JIDs that do not carry one", () => {
    assert.equal(phoneFromJid("120363000000000000@g.us"), undefined);
    assert.equal(phoneFromJid("98765432101234@lid"), undefined);
    assert.equal(phoneFromJid("status@broadcast"), undefined);
  });
});

describe("matchPrefix", () => {
  test("matches a country code", () => {
    const match = matchPrefix("2348035550199", [rule("234")]);
    assert.equal(match?.prefix, "234");
  });

  test("matches a NANP area code as the longer prefix it is", () => {
    const rules = [rule("1917"), rule("1212")];
    assert.equal(matchPrefix("19175550123", rules)?.prefix, "1917");
    assert.equal(matchPrefix("13475550123", rules), undefined, "347 is not in the list");
  });

  test("the longest prefix wins, which is how an exception is expressed", () => {
    const rules = [rule("234"), rule("234803", "allow")];
    const blocked = matchPrefix("2349015550111", rules);
    assert.equal(blocked?.rule.kind, "block");
    const allowed = matchPrefix("2348035550199", rules);
    assert.equal(allowed?.rule.kind, "allow", "the more specific allow beats the country block");
  });

  test("an exception can itself have an exception", () => {
    const rules = [rule("91"), rule("9198", "allow"), rule("919876")];
    assert.equal(matchPrefix("919876543210", rules)?.rule.kind, "block");
    assert.equal(matchPrefix("919812345678", rules)?.rule.kind, "allow");
  });

  test("no rules means no match, and the order rules arrive in never matters", () => {
    assert.equal(matchPrefix("2348035550199", []), undefined);
    const forwards = [rule("234"), rule("234803", "allow")];
    const backwards = [...forwards].reverse();
    assert.equal(
      matchPrefix("2348035550199", forwards)?.rule.id,
      matchPrefix("2348035550199", backwards)?.rule.id,
    );
  });

  test("a prefix only matches at the start of the number", () => {
    // 234 appears inside this Indian number but is not its country code.
    assert.equal(matchPrefix("919234567890", [rule("234")]), undefined);
  });
});

describe("formatPhone", () => {
  test("renders NANP numbers the way people read them", () => {
    assert.equal(formatPhone("19175550123"), "+1 (917) 555-0123");
    assert.equal(formatPhone("2348035550199"), "+2348035550199");
  });
});
