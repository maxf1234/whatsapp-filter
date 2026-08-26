/**
 * The activity log, and the queue of destructive actions waiting out their delay.
 *
 * Both exist for the same reason: a deleted WhatsApp chat leaves no trace on the
 * phone, so if this service does not write down what it did, nobody can ever
 * check whether it was right.
 */

import { many, one } from "../lib/db.ts";
import type { Querier } from "../lib/db.ts";
import type { FilterAction, FilterDecision, Verdict } from "./decide.ts";

export interface EventRow {
  id: string;
  occurred_at: string;
  remote_jid: string;
  phone_e164: string | null;
  matched_prefix: string | null;
  matched_rule_id: string | null;
  decision: FilterDecision;
  action_taken: FilterAction | null;
  is_group: boolean;
  detail: string | null;
}

export async function recordEvent(
  q: Querier,
  input: {
    accountId: string;
    sessionId: string | null;
    remoteJid: string;
    verdict: Pick<Verdict, "decision" | "phone" | "matchedPrefix" | "matchedRuleId" | "isGroup" | "detail">;
    actionTaken?: FilterAction | null;
    detail?: string | null;
  },
): Promise<string> {
  const row = await one<{ id: string }>(
    q,
    `insert into filter_events
       (account_id, session_id, remote_jid, phone_e164, matched_prefix, matched_rule_id,
        decision, action_taken, is_group, detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning id`,
    [
      input.accountId,
      input.sessionId,
      input.remoteJid,
      input.verdict.phone ?? null,
      input.verdict.matchedPrefix ?? null,
      input.verdict.matchedRuleId ?? null,
      input.verdict.decision,
      input.actionTaken ?? null,
      input.verdict.isGroup,
      input.detail ?? input.verdict.detail ?? null,
    ],
  );
  return row!.id;
}

export interface ListEventsOptions {
  limit?: number;
  before?: string;
  decision?: FilterDecision;
}

export async function listEvents(
  q: Querier,
  accountId: string,
  options: ListEventsOptions = {},
): Promise<EventRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  return many<EventRow>(
    q,
    `select id, occurred_at, remote_jid, phone_e164, matched_prefix, matched_rule_id,
            decision, action_taken, is_group, detail
       from filter_events
      where account_id = $1
        and ($2::timestamptz is null or occurred_at < $2)
        and ($3::filter_decision is null or decision = $3)
      order by occurred_at desc
      limit ${limit}`,
    [accountId, options.before ?? null, options.decision ?? null],
  );
}

/**
 * A rolling count of what the filter has been doing, which is the number the
 * dashboard leads with. Split by decision so "would_block" is visible next to
 * "blocked" — that difference is the whole story before an account is armed.
 */
export async function eventSummary(
  q: Querier,
  accountId: string,
  sinceHours = 24 * 7,
): Promise<Record<string, number>> {
  const rows = await many<{ decision: FilterDecision; n: number }>(
    q,
    `select decision, count(*)::bigint as n
       from filter_events
      where account_id = $1 and occurred_at > now() - make_interval(hours => $2)
      group by decision`,
    [accountId, sinceHours],
  );
  return Object.fromEntries(rows.map((r) => [r.decision, r.n]));
}

// ---------------------------------------------------------------- pending actions

export interface PendingRow {
  id: string;
  account_id: string;
  session_id: string;
  remote_jid: string;
  action: FilterAction;
  last_message: unknown;
  due_at: string;
  attempts: number;
}

/**
 * Queue a held action. A second message from the same chat while one is pending
 * refreshes the message key but leaves `due_at` alone: a spammer sending ten
 * messages should not be able to push their own deletion further away, and
 * should not get ten deletions either.
 */
export async function enqueuePending(
  q: Querier,
  input: {
    accountId: string;
    sessionId: string;
    remoteJid: string;
    action: FilterAction;
    lastMessage: unknown;
    delaySeconds: number;
  },
): Promise<void> {
  await q.query(
    `insert into pending_actions (account_id, session_id, remote_jid, action, last_message, due_at)
     values ($1,$2,$3,$4,$5::jsonb, now() + make_interval(secs => $6))
     on conflict (session_id, remote_jid) do update
        set last_message = excluded.last_message,
            action       = excluded.action`,
    [
      input.accountId,
      input.sessionId,
      input.remoteJid,
      input.action,
      JSON.stringify(input.lastMessage),
      input.delaySeconds,
    ],
  );
}

/** Claims due rows so two workers cannot act on the same chat twice. */
export async function claimDuePending(q: Querier, limit = 50): Promise<PendingRow[]> {
  return many<PendingRow>(
    q,
    `delete from pending_actions
      where id in (
        select id from pending_actions
         where due_at <= now()
         order by due_at
         limit $1
         for update skip locked)
      returning id, account_id, session_id, remote_jid, action, last_message, due_at, attempts`,
    [limit],
  );
}

export async function requeuePending(q: Querier, row: PendingRow, retryInSeconds: number): Promise<void> {
  await q.query(
    `insert into pending_actions
       (account_id, session_id, remote_jid, action, last_message, due_at, attempts)
     values ($1,$2,$3,$4,$5::jsonb, now() + make_interval(secs => $6), $7)
     on conflict (session_id, remote_jid) do update set attempts = excluded.attempts`,
    [
      row.account_id,
      row.session_id,
      row.remote_jid,
      row.action,
      JSON.stringify(row.last_message),
      retryInSeconds,
      row.attempts + 1,
    ],
  );
}

export async function listPending(q: Querier, accountId: string): Promise<PendingRow[]> {
  return many<PendingRow>(
    q,
    `select id, account_id, session_id, remote_jid, action, last_message, due_at, attempts
       from pending_actions where account_id = $1 order by due_at`,
    [accountId],
  );
}

export async function cancelPending(q: Querier, id: string): Promise<boolean> {
  const result = await q.query(`delete from pending_actions where id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

/** Nightly sweep. Rollups do not exist here, so the raw rows are all there is — hence 90 days, not 30. */
export async function purgeOldEvents(q: Querier, retentionDays: number): Promise<number> {
  const result = await q.query(
    `delete from filter_events where occurred_at < now() - make_interval(days => $1)`,
    [retentionDays],
  );
  return result.rowCount ?? 0;
}
