/** Signup, and the settings that decide whether the filter is allowed to act. */

import { asService, asPrincipal, one, many } from "../lib/db.ts";
import type { Querier } from "../lib/db.ts";
import type { AccountSettings } from "./decide.ts";
import { conflict, notFound } from "../lib/errors.ts";

export interface AccountRow {
  account_id: string;
  user_id: string;
  email: string;
  role: "owner" | "member";
}

export interface SettingsRow {
  account_id: string;
  action: AccountSettings["action"];
  armed: boolean;
  armed_at: string | null;
  delete_delay_seconds: number;
  apply_to_known_contacts: boolean;
  apply_to_groups: boolean;
  reject_calls: boolean;
}

/**
 * Signup has no principal yet, so it runs as the service role. One user gets one
 * account; signing up twice with the same email returns the account that exists
 * rather than making a second one, which keeps the landing page's "get started"
 * button idempotent under a double click.
 */
export async function signUp(email: string): Promise<AccountRow> {
  const normalized = email.trim().toLowerCase();
  return asService(async (q) => {
    const existing = await one<AccountRow>(
      q,
      `select m.account_id, u.id as user_id, u.email, m.role
         from users u
         join account_members m on m.user_id = u.id
        where u.email = $1`,
      [normalized],
    );
    if (existing) return existing;

    const user = await one<{ id: string }>(
      q,
      `insert into users (email) values ($1)
       on conflict (email) do update set email = excluded.email
       returning id`,
      [normalized],
    );
    if (!user) throw conflict("could not create user");

    const account = await one<{ id: string }>(
      q,
      `insert into accounts (owner_user_id) values ($1) returning id`,
      [user.id],
    );
    if (!account) throw conflict("could not create account");

    await q.query(`insert into account_settings (account_id) values ($1)`, [account.id]);
    const member = await one<AccountRow>(
      q,
      `insert into account_members (account_id, user_id, role) values ($1, $2, 'owner')
       returning account_id, user_id, 'owner'::member_role as role,
                 (select email from users where id = $2) as email`,
      [account.id, user.id],
    );
    if (!member) throw conflict("could not create membership");
    return member;
  });
}

/** The account a logged-in user acts on. RLS already limits this to their own. */
export async function accountForUser(userId: string): Promise<AccountRow> {
  const rows = await asPrincipal({ sub: userId }, (q) =>
    many<AccountRow>(
      q,
      `select m.account_id, m.user_id, m.role, u.email
         from account_members m join users u on u.id = m.user_id
        where m.user_id = $1
        order by m.role, m.account_id
        limit 1`,
      [userId],
    ),
  );
  const row = rows[0];
  if (!row) throw notFound("no account for this user");
  return row;
}

export async function getSettings(q: Querier, accountId: string): Promise<SettingsRow> {
  const row = await one<SettingsRow>(
    q,
    `select account_id, action, armed, armed_at, delete_delay_seconds,
            apply_to_known_contacts, apply_to_groups, reject_calls
       from account_settings where account_id = $1`,
    [accountId],
  );
  if (!row) throw notFound("settings not found");
  return row;
}

export function toSettings(row: SettingsRow): AccountSettings {
  return {
    action: row.action,
    armed: row.armed,
    deleteDelaySeconds: row.delete_delay_seconds,
    applyToKnownContacts: row.apply_to_known_contacts,
    applyToGroups: row.apply_to_groups,
    rejectCalls: row.reject_calls,
  };
}

export interface SettingsPatch {
  action?: AccountSettings["action"];
  armed?: boolean;
  deleteDelaySeconds?: number;
  applyToKnownContacts?: boolean;
  applyToGroups?: boolean;
  rejectCalls?: boolean;
}

/**
 * `armed_at` is stamped by the update rather than by the caller, so the activity
 * log can always answer "was this account armed when that message arrived?"
 * against a timestamp nobody had the chance to backdate.
 */
export async function updateSettings(
  q: Querier,
  accountId: string,
  patch: SettingsPatch,
): Promise<SettingsRow> {
  const row = await one<SettingsRow>(
    q,
    `update account_settings set
        action                  = coalesce($2, action),
        armed                   = coalesce($3, armed),
        armed_at                = case
                                    when $3 is null then armed_at
                                    when $3 and not armed then now()
                                    when not $3 then null
                                    else armed_at
                                  end,
        delete_delay_seconds    = coalesce($4, delete_delay_seconds),
        apply_to_known_contacts = coalesce($5, apply_to_known_contacts),
        apply_to_groups         = coalesce($6, apply_to_groups),
        reject_calls            = coalesce($7, reject_calls),
        updated_at              = now()
      where account_id = $1
      returning account_id, action, armed, armed_at, delete_delay_seconds,
                apply_to_known_contacts, apply_to_groups, reject_calls`,
    [
      accountId,
      patch.action ?? null,
      patch.armed ?? null,
      patch.deleteDelaySeconds ?? null,
      patch.applyToKnownContacts ?? null,
      patch.applyToGroups ?? null,
      patch.rejectCalls ?? null,
    ],
  );
  if (!row) throw notFound("settings not found");
  return row;
}
