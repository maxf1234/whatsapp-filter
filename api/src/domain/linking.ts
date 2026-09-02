/**
 * The pairing lifecycle: the row that represents "this account's WhatsApp",
 * from a phone number typed on the landing page to a live socket.
 *
 * The flow is deliberately pull-based. The API writes the intent and returns;
 * the worker notices, opens a socket, asks WhatsApp for a pairing code, and
 * writes it back; the dashboard polls until it appears. Nothing in the request
 * path waits on WhatsApp, so a slow or refusing WhatsApp is a screen that says
 * "still working" rather than a timed-out HTTP request.
 */

import { one, many } from "../lib/db.ts";
import type { Querier } from "../lib/db.ts";
import { conflict, notFound } from "../lib/errors.ts";

export type SessionStatus = "unlinked" | "pairing" | "linked" | "logged_out" | "revoked";

export interface SessionRow {
  id: string;
  account_id: string;
  phone_e164: string;
  status: SessionStatus;
  pairing_code: string | null;
  pairing_requested_at: string | null;
  pairing_expires_at: string | null;
  wa_jid: string | null;
  linked_at: string | null;
  last_connected_at: string | null;
  last_disconnect_reason: string | null;
  created_at: string;
}

const COLUMNS = `id, account_id, phone_e164, status, pairing_code, pairing_requested_at,
                 pairing_expires_at, wa_jid, linked_at, last_connected_at,
                 last_disconnect_reason, created_at`;

export async function currentSession(q: Querier, accountId: string): Promise<SessionRow | undefined> {
  return one<SessionRow>(
    q,
    `select ${COLUMNS} from sessions
      where account_id = $1 and status in ('unlinked','pairing','linked')`,
    [accountId],
  );
}

/**
 * Start linking. Called by the API as the service role because it writes a
 * sessions row, which no subscriber-facing policy allows.
 *
 * Re-requesting while a session is already pairing resets the code rather than
 * erroring: a subscriber whose code expired on screen presses the button again,
 * and that should work.
 */
export async function requestLink(
  q: Querier,
  accountId: string,
  phoneE164: string,
): Promise<SessionRow> {
  const existing = await currentSession(q, accountId);

  if (existing?.status === "linked") {
    if (existing.phone_e164 === phoneE164) return existing;
    throw conflict(
      "this account is already linked to a different number; unlink it first",
      "already_linked",
    );
  }

  if (existing) {
    const row = await one<SessionRow>(
      q,
      `update sessions
          set phone_e164 = $2,
              status = 'pairing',
              pairing_code = null,
              pairing_requested_at = now(),
              pairing_expires_at = null
        where id = $1
        returning ${COLUMNS}`,
      [existing.id, phoneE164],
    );
    return row!;
  }

  const row = await one<SessionRow>(
    q,
    `insert into sessions (account_id, phone_e164, status, pairing_requested_at)
     values ($1, $2, 'pairing', now())
     returning ${COLUMNS}`,
    [accountId, phoneE164],
  );
  return row!;
}

/** The worker's half: sessions it should be holding a socket open for. */
export async function sessionsToRun(q: Querier): Promise<SessionRow[]> {
  return many<SessionRow>(
    q,
    `select ${COLUMNS} from sessions where status in ('pairing','linked') order by created_at`,
  );
}

export async function sessionById(q: Querier, id: string): Promise<SessionRow | undefined> {
  return one<SessionRow>(q, `select ${COLUMNS} from sessions where id = $1`, [id]);
}

export async function savePairingCode(
  q: Querier,
  sessionId: string,
  code: string,
  ttlSeconds: number,
): Promise<void> {
  await q.query(
    `update sessions
        set pairing_code = $2,
            pairing_requested_at = now(),
            pairing_expires_at = now() + make_interval(secs => $3),
            status = 'pairing'
      where id = $1 and status <> 'linked'`,
    [sessionId, code, ttlSeconds],
  );
}

/** The code has done its job and should stop being readable the moment it has. */
export async function markLinked(q: Querier, sessionId: string, waJid: string): Promise<void> {
  await q.query(
    `update sessions
        set status = 'linked',
            wa_jid = $2,
            linked_at = coalesce(linked_at, now()),
            last_connected_at = now(),
            last_disconnect_reason = null,
            pairing_code = null,
            pairing_expires_at = null
      where id = $1`,
    [sessionId, waJid],
  );
}

export async function markDisconnected(
  q: Querier,
  sessionId: string,
  reason: string,
  loggedOut: boolean,
): Promise<void> {
  await q.query(
    `update sessions
        set last_disconnect_reason = $2,
            status = case when $3 then 'logged_out'::session_status else status end,
            pairing_code = case when $3 then null else pairing_code end
      where id = $1`,
    [sessionId, reason, loggedOut],
  );
}

/**
 * Unlink. The credential rows go with it — an unlinked session that kept its
 * creds would be a WhatsApp login sitting in the database that the subscriber
 * believes they have revoked. `on delete cascade` does the deletion; this is
 * here to say that it is deliberate.
 */
export async function revokeSession(q: Querier, accountId: string): Promise<boolean> {
  const session = await currentSession(q, accountId);
  if (!session) return false;
  await q.query(`delete from session_auth_state where session_id = $1`, [session.id]);
  await q.query(`delete from pending_actions where session_id = $1`, [session.id]);
  await q.query(
    `update sessions set status = 'revoked', revoked_at = now(), pairing_code = null,
            pairing_expires_at = null
      where id = $1`,
    [session.id],
  );
  return true;
}

export async function requireSession(q: Querier, accountId: string): Promise<SessionRow> {
  const session = await currentSession(q, accountId);
  if (!session) throw notFound("no WhatsApp session for this account");
  return session;
}
