/** Rule storage. The matching itself is in phone.ts; this is only how rules get in and out. */

import { one, many } from "../lib/db.ts";
import type { Querier } from "../lib/db.ts";
import type { PrefixRule } from "./phone.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";

export interface RuleRow {
  id: string;
  account_id: string;
  kind: "block" | "allow";
  prefix: string;
  label: string | null;
  enabled: boolean;
  created_at: string;
}

const PREFIX = /^[1-9][0-9]{0,14}$/;

/**
 * Accepts what a person types — `+234`, `234`, `(917)` — and returns the digits
 * a rule is stored as. A bare NANP area code is the one input that cannot be
 * taken at face value: '917' as written means the New York area code, but as a
 * prefix it means Kyrgyzstan's 996-adjacent range and anything else starting 917.
 * The caller decides, via `assumeNanpAreaCode`, which reading applies; the
 * dashboard sets it when the picker's NANP tab is active.
 */
export function normalizePrefix(input: string, assumeNanpAreaCode = false): string {
  let digits = input.replace(/[^0-9]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (assumeNanpAreaCode && digits.length === 3) digits = `1${digits}`;
  if (!PREFIX.test(digits)) {
    throw badRequest(`"${input}" is not a usable dialling prefix`, "invalid_prefix");
  }
  return digits;
}

export async function listRules(q: Querier, accountId: string): Promise<RuleRow[]> {
  return many<RuleRow>(
    q,
    `select id, account_id, kind, prefix, label, enabled, created_at
       from rules where account_id = $1
      order by length(prefix), prefix`,
    [accountId],
  );
}

/** Just what the matcher needs, and only the rules that are switched on. */
export async function activeRules(q: Querier, accountId: string): Promise<PrefixRule[]> {
  return many<PrefixRule>(
    q,
    `select id, kind, prefix, label from rules where account_id = $1 and enabled`,
    [accountId],
  );
}

export async function createRule(
  q: Querier,
  accountId: string,
  input: { kind: "block" | "allow"; prefix: string; label?: string | null },
): Promise<RuleRow> {
  const label =
    input.label ??
    (
      await one<{ name: string }>(q, `select name from dial_prefixes where prefix = $1`, [
        input.prefix,
      ])
    )?.name ??
    null;

  const row = await one<RuleRow>(
    q,
    `insert into rules (account_id, kind, prefix, label) values ($1, $2, $3, $4)
     returning id, account_id, kind, prefix, label, enabled, created_at`,
    [accountId, input.kind, input.prefix, label],
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "23505") {
      throw conflict(`there is already a rule for +${input.prefix}`, "duplicate_prefix");
    }
    throw error;
  });
  // RLS returns no row rather than an error when the caller is not an owner.
  if (!row) throw notFound("account not found");
  return row;
}

export async function updateRule(
  q: Querier,
  ruleId: string,
  patch: { kind?: "block" | "allow"; label?: string | null; enabled?: boolean },
): Promise<RuleRow> {
  const row = await one<RuleRow>(
    q,
    `update rules set
        kind    = coalesce($2, kind),
        label   = coalesce($3, label),
        enabled = coalesce($4, enabled)
      where id = $1
      returning id, account_id, kind, prefix, label, enabled, created_at`,
    [ruleId, patch.kind ?? null, patch.label ?? null, patch.enabled ?? null],
  );
  if (!row) throw notFound("rule not found");
  return row;
}

export async function deleteRule(q: Querier, ruleId: string): Promise<void> {
  const result = await q.query(`delete from rules where id = $1`, [ruleId]);
  if (result.rowCount === 0) throw notFound("rule not found");
}

/**
 * Bulk add, which is how a subscriber's list of countries actually arrives —
 * pasted, or ticked in the picker, not typed one at a time.
 *
 * One statement rather than a loop over createRule: a unique violation inside a
 * transaction aborts it, so catching one per prefix in JavaScript would leave
 * the rest of the batch running against a dead transaction. `on conflict do
 * nothing` lets prefixes already on the account be reported instead, which is
 * what re-submitting a list with one new entry should do.
 */
export async function createRules(
  q: Querier,
  accountId: string,
  kind: "block" | "allow",
  prefixes: readonly string[],
): Promise<{ created: RuleRow[]; skipped: string[] }> {
  const wanted = [...new Set(prefixes)];
  if (wanted.length === 0) return { created: [], skipped: [] };

  const created = await many<RuleRow>(
    q,
    `insert into rules (account_id, kind, prefix, label)
     select $1, $2::rule_kind, p, (select name from dial_prefixes d where d.prefix = p)
       from unnest($3::text[]) as p
     on conflict (account_id, prefix) do nothing
     returning id, account_id, kind, prefix, label, enabled, created_at`,
    [accountId, kind, wanted],
  );

  const madeIt = new Set(created.map((r) => r.prefix));
  return { created, skipped: wanted.filter((p) => !madeIt.has(p)) };
}
