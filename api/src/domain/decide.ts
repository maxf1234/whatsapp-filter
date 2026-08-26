/**
 * The filter's decision, as a pure function.
 *
 * Nothing here touches WhatsApp or Postgres. Given what we know about one
 * incoming message, it answers two questions — what did we conclude, and what
 * should be done about it — and the caller is responsible for doing it. Keeping
 * the judgement separate from the enforcement is what makes it possible to test
 * "an unarmed account never deletes" as a property rather than by hoping the
 * socket code checks a flag in every branch it grew.
 */

import { isGroupJid, isLidJid, isConversationalJid, matchPrefix, phoneFromJid } from "./phone.ts";
import type { PrefixRule } from "./phone.ts";

export type FilterAction = "log_only" | "archive" | "delete" | "block_and_delete";

export type FilterDecision =
  | "blocked"
  | "would_block"
  | "allowed"
  | "no_match"
  | "skipped_group"
  | "skipped_known"
  | "skipped_self"
  | "unresolved_jid"
  | "error";

export interface AccountSettings {
  action: FilterAction;
  armed: boolean;
  deleteDelaySeconds: number;
  applyToKnownContacts: boolean;
  applyToGroups: boolean;
  rejectCalls: boolean;
}

export interface IncomingMessage {
  remoteJid: string;
  /** True when the subscriber sent it from another of their own devices. */
  fromMe: boolean;
  /** The individual sender inside a group; absent for a 1:1 chat. */
  participantJid?: string;
  /** Whether the number is already in the subscriber's address book. */
  isKnownContact: boolean;
}

export interface Verdict {
  decision: FilterDecision;
  /** What the caller should carry out. `log_only` means "write the row, touch nothing". */
  action: FilterAction;
  /** How long to wait before carrying it out. Zero means immediately. */
  delaySeconds: number;
  phone?: string;
  matchedPrefix?: string;
  matchedRuleId?: string;
  isGroup: boolean;
  /** Free text for the activity log. Never message content. */
  detail?: string;
}

function verdict(decision: FilterDecision, isGroup: boolean, rest: Partial<Verdict> = {}): Verdict {
  return { decision, action: "log_only", delaySeconds: 0, isGroup, ...rest };
}

export function decide(
  message: IncomingMessage,
  rules: readonly PrefixRule[],
  settings: AccountSettings,
): Verdict {
  const isGroup = isGroupJid(message.remoteJid);

  // Our own outgoing messages arrive here too, mirrored from the phone. Acting
  // on one would mean deleting a chat because of who *we* are.
  if (message.fromMe) return verdict("skipped_self", isGroup);

  if (!isConversationalJid(message.remoteJid)) return verdict("skipped_self", isGroup);

  if (isGroup && !settings.applyToGroups) return verdict("skipped_group", true);

  // In a group the chat belongs to everyone in it, so the number to judge is the
  // individual participant's, not the group's.
  const subjectJid = isGroup ? message.participantJid : message.remoteJid;
  if (!subjectJid) return verdict("unresolved_jid", isGroup);

  const phone = phoneFromJid(subjectJid);
  if (!phone) {
    // A LID is a real identity we simply cannot read a country code from. It is
    // recorded rather than treated as a miss, so "the filter never fires on this
    // contact" shows up in the activity log instead of looking like a quiet pass.
    return verdict("unresolved_jid", isGroup, { detail: isLidJid(subjectJid) ? "lid" : "unparsable" });
  }

  // Someone in the address book is someone the subscriber chose to know. Checked
  // before the rules so a saved contact is never even evaluated by default.
  if (message.isKnownContact && !settings.applyToKnownContacts) {
    return verdict("skipped_known", isGroup, { phone });
  }

  const match = matchPrefix(phone, rules);
  if (!match) return verdict("no_match", isGroup, { phone });

  const matched = { phone, matchedPrefix: match.prefix, matchedRuleId: match.rule.id };

  if (match.rule.kind === "allow") return verdict("allowed", isGroup, matched);

  // Matched a block rule. Whether anything happens is a separate question, and
  // this is the only place that answers it: an account that is not armed records
  // what it would have done and stops. It is what makes it safe to hand someone
  // an irreversible action as the default — they can watch it be right for a day
  // before it can touch anything.
  if (!settings.armed || settings.action === "log_only") {
    return verdict("would_block", isGroup, matched);
  }

  return {
    decision: "blocked",
    action: settings.action,
    // Deletes are held; archiving is reversible and not worth delaying.
    delaySeconds: settings.action === "archive" ? 0 : settings.deleteDelaySeconds,
    isGroup,
    ...matched,
  };
}

/**
 * Calls get the same rules but never a delay: a call is answered or missed in
 * seconds, so a held decision is no decision. Rejection is also the one action
 * here that cannot destroy anything, which is why it is not gated on `armed`.
 */
export function decideCall(
  callerJid: string,
  rules: readonly PrefixRule[],
  settings: AccountSettings,
): { reject: boolean; phone?: string; matchedPrefix?: string; matchedRuleId?: string } {
  if (!settings.rejectCalls) return { reject: false };
  const phone = phoneFromJid(callerJid);
  if (!phone) return { reject: false };
  const match = matchPrefix(phone, rules);
  if (!match || match.rule.kind === "allow") return { reject: false, phone };
  return { reject: true, phone, matchedPrefix: match.prefix, matchedRuleId: match.rule.id };
}
