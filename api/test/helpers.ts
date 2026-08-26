/**
 * Shared setup for the tests that need a real Postgres.
 *
 * These share one database and truncate between cases, so they run with
 * --test-concurrency=1. Running them in parallel turns the suite red in a way
 * that looks like a code failure and is not.
 */

import { asService, asPrincipal, getPool, one } from "../src/lib/db.ts";
import type { Querier } from "../src/lib/db.ts";
import { mintSessionToken } from "../src/lib/auth.ts";
import { signUp } from "../src/domain/accounts.ts";
import { buildApp } from "../src/app.ts";

export async function resetDatabase(): Promise<void> {
  await asService(async (q) => {
    // filter_events and the rest cascade from accounts and users.
    await q.query("truncate users, accounts cascade");
  });
}

export interface Subject {
  userId: string;
  accountId: string;
  email: string;
  token: string;
  /** Runs a query as this subscriber, under RLS, exactly as a route would. */
  as<T>(fn: (q: Querier) => Promise<T>): Promise<T>;
}

let counter = 0;

export async function createSubject(email?: string): Promise<Subject> {
  const address = email ?? `subject-${++counter}-${Date.now()}@example.test`;
  const account = await signUp(address);
  return {
    userId: account.user_id,
    accountId: account.account_id,
    email: account.email,
    token: await mintSessionToken(account.user_id),
    as: (fn) => asPrincipal({ sub: account.user_id }, fn),
  };
}

/**
 * Drop the starter block list from an account.
 *
 * Signup seeds 29 rules, which is right for the product and in the way of any
 * test asserting "this account has exactly the rules I gave it". Tests that care
 * about the starter list say so; the rest start from empty on purpose.
 */
export async function clearRules(accountId: string): Promise<void> {
  await asService((q) => q.query(`delete from rules where account_id = $1`, [accountId]));
}

/** A session row in whatever state a test needs, without going near a socket. */
export async function linkSession(
  accountId: string,
  phone: string,
  status: "pairing" | "linked" = "linked",
): Promise<string> {
  return asService(async (q) => {
    const row = await one<{ id: string }>(
      q,
      `insert into sessions (account_id, phone_e164, status, wa_jid, linked_at)
       values ($1, $2, $3::session_status, $4,
               case when $3::session_status = 'linked' then now() end)
       returning id`,
      [accountId, phone, status, `${phone}:1@s.whatsapp.net`],
    );
    return row!.id;
  });
}

export async function buildTestApp() {
  return buildApp({});
}

export function authHeader(subject: Subject): Record<string, string> {
  return { authorization: `Bearer ${subject.token}` };
}

export async function closeAll(): Promise<void> {
  await getPool().end().catch(() => {});
}
