/**
 * Turning what WhatsApp hands us into digits, and deciding what those digits mean.
 *
 * Every rule in this product is a leading-digit prefix on the full international
 * number with no '+'. That one shape covers both things subscribers ask for:
 *
 *   '234'   — all of Nigeria, because 234 is its country code
 *   '1917'  — the 917 area code, because a NANP number is 1 + NPA + 7 digits,
 *             which makes an area code just a longer country prefix
 *
 * so there is no separate "area code mode" to get wrong.
 */

/** A WhatsApp JID: `15551234567@s.whatsapp.net`, `…@g.us`, `…@lid`, `…@broadcast`. */
export type Jid = string;

export interface JidParts {
  /** Everything before the '@', with any `:device` suffix and any `_…` session part removed. */
  user: string;
  server: string;
}

export function parseJid(jid: Jid): JidParts | undefined {
  const at = jid.indexOf("@");
  if (at <= 0) return undefined;
  const server = jid.slice(at + 1);
  if (!server) return undefined;
  // A JID from a linked device carries `:12`; a participant JID can carry `_1`.
  const user = jid.slice(0, at).split(":")[0]!.split("_")[0]!;
  return { user, server };
}

export function isGroupJid(jid: Jid): boolean {
  return parseJid(jid)?.server === "g.us";
}

/**
 * WhatsApp's newer "linked identity" JIDs. They are stable per-contact handles
 * that deliberately are not phone numbers, so there is nothing here to match a
 * prefix against — the caller has to resolve one to a phone JID first, or record
 * an `unresolved_jid` decision and leave the chat alone. Silently treating a LID
 * as "no match" would be the same outcome by accident rather than on purpose.
 */
export function isLidJid(jid: Jid): boolean {
  return parseJid(jid)?.server === "lid";
}

/** Servers that are not a person we could have a filterable conversation with. */
const NON_CONVERSATION_SERVERS = new Set(["broadcast", "newsletter", "call", "status"]);

export function isConversationalJid(jid: Jid): boolean {
  const parts = parseJid(jid);
  return parts !== undefined && !NON_CONVERSATION_SERVERS.has(parts.server);
}

/**
 * E.164 without the '+': 7 to 15 digits, no leading zero.
 *
 * The lower bound is deliberately loose. Real numbering plans go down to 8
 * digits including the country code (Niue, +683 xxxx), and a bound that is too
 * tight would reject a real sender rather than a fake one.
 */
const E164 = /^[1-9][0-9]{6,14}$/;

export function isE164(digits: string): boolean {
  return E164.test(digits);
}

/**
 * Digits from anything a human or WhatsApp might hand us: a JID, `+1 (917)
 * 555-0123`, `00234803…`. Returns undefined rather than a best guess when the
 * result is not a plausible international number — a wrong normalisation here
 * would delete the wrong conversation.
 */
export function normalizePhone(input: string): string | undefined {
  const beforeAt = input.includes("@") ? (parseJid(input)?.user ?? "") : input;
  let digits = beforeAt.replace(/[^0-9]/g, "");
  if (!digits) return undefined;
  // `00` is the international prefix in most of the world and `011` in the NANP.
  // Both mean "what follows is a full international number".
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("011")) digits = digits.slice(3);
  return isE164(digits) ? digits : undefined;
}

/**
 * The phone number behind a JID, or undefined if it does not carry one — a
 * group, a LID, a broadcast list, or a malformed JID.
 */
export function phoneFromJid(jid: Jid): string | undefined {
  const parts = parseJid(jid);
  if (!parts || parts.server !== "s.whatsapp.net") return undefined;
  return isE164(parts.user) ? parts.user : undefined;
}

/** A rule as the matcher needs it. Mirrors the `rules` row minus the bookkeeping. */
export interface PrefixRule {
  id: string;
  kind: "block" | "allow";
  prefix: string;
  label?: string | null;
}

export interface PrefixMatch {
  rule: PrefixRule;
  prefix: string;
}

/**
 * Longest matching prefix wins, and that is the entire conflict resolution.
 *
 * It gives the exception subscribers actually want without a second concept:
 * block '234' and allow '234803' and the one Lagos number you do business with
 * keeps working, because its rule is longer. Two rules can never tie — the
 * schema holds one verdict per (account, prefix) — so the winner is unique and
 * the order rules are loaded in does not matter.
 */
export function matchPrefix(phone: string, rules: readonly PrefixRule[]): PrefixMatch | undefined {
  let best: PrefixRule | undefined;
  for (const rule of rules) {
    if (!phone.startsWith(rule.prefix)) continue;
    if (best === undefined || rule.prefix.length > best.prefix.length) best = rule;
  }
  return best && { rule: best, prefix: best.prefix };
}

/** Formats digits for display. Never used for matching. */
export function formatPhone(digits: string): string {
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return `+${digits}`;
}
