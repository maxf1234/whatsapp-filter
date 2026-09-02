/**
 * One WhatsApp socket per linked account, supervised.
 *
 * The manager owns the whole lifecycle: it reads which sessions should be up,
 * opens what is missing, closes what is no longer wanted, asks WhatsApp for
 * pairing codes, and re-opens a socket that dropped with a backoff. The API
 * never talks to WhatsApp — it writes a row and nudges this.
 *
 * Everything it does against Postgres runs as the service role, because it acts
 * for every account at once and it is the only thing in the system permitted to
 * read a subscriber's credentials.
 */

import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import type { WASocket, WAMessage, ConnectionState } from "@whiskeysockets/baileys";
import { asService } from "../lib/db.ts";
import { env } from "../lib/env.ts";
import { useDbAuthState } from "./dbAuthState.ts";
import { anchorFrom, applyAction, rejectCall } from "./enforce.ts";
import type { MessageAnchor } from "./enforce.ts";
import { decide, decideCall } from "../domain/decide.ts";
import type { Verdict } from "../domain/decide.ts";
import { activeRules } from "../domain/rules.ts";
import { getSettings, toSettings } from "../domain/accounts.ts";
import {
  claimDuePending, enqueuePending, purgeOldEvents, recordEvent, requeuePending,
} from "../domain/activity.ts";
import { markDisconnected, markLinked, savePairingCode, sessionById, sessionsToRun } from "../domain/linking.ts";
import type { SessionRow } from "../domain/linking.ts";
import { maskPhone } from "../lib/logging.ts";
import type { PrefixRule } from "../domain/phone.ts";
import type { AccountSettings } from "../domain/decide.ts";

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
}

/** Baileys wants a pino-like logger. Ours is quieter and does not carry message bodies. */
const silentLogger = {
  level: "silent" as const,
  child() { return silentLogger; },
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

interface Live {
  sessionId: string;
  accountId: string;
  phone: string;
  sock: WASocket;
  /** Bumped on every (re)connect so a late event from a dead socket can be ignored. */
  generation: number;
  closing: boolean;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
}

interface CachedPolicy {
  rules: PrefixRule[];
  settings: AccountSettings;
  loadedAt: number;
}

const POLICY_TTL_MS = 30_000;
const MAX_PENDING_ATTEMPTS = 5;

export class SessionManager {
  #live = new Map<string, Live>();
  #policy = new Map<string, CachedPolicy>();
  #log: Logger = console;
  #timer?: NodeJS.Timeout;
  #reconciling = false;
  #stopped = false;
  #waVersion?: [number, number, number];
  #lastPurgeDay = "";

  start(log: Logger): void {
    this.#log = log;
    this.#stopped = false;
    const tick = () => {
      void this.#tick();
    };
    this.#timer = setInterval(tick, env.workerTickSeconds * 1000);
    tick();
  }

  /** Called by the API right after it writes a linking intent, so the code arrives in seconds. */
  reconcileSoon(): void {
    setTimeout(() => void this.#tick(), 250);
  }

  /** Rules and settings are cached per account; this drops the cache after a dashboard edit. */
  invalidateRules(accountId: string): void {
    this.#policy.delete(accountId);
  }

  async stop(accountId: string): Promise<void> {
    const live = this.#live.get(accountId);
    if (!live) return;
    live.closing = true;
    if (live.reconnectTimer) clearTimeout(live.reconnectTimer);
    this.#live.delete(accountId);
    this.#policy.delete(accountId);
    try {
      live.sock.end(undefined);
    } catch {
      // A socket that is already gone is the outcome we wanted.
    }
  }

  async stopAll(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await Promise.all([...this.#live.keys()].map((id) => this.stop(id)));
  }

  // ------------------------------------------------------------ the loop

  async #tick(): Promise<void> {
    if (this.#stopped || this.#reconciling) return;
    this.#reconciling = true;
    try {
      await this.#reconcileSessions();
      await this.#drainPending();
      await this.#purgeDaily();
    } catch (error) {
      this.#log.error({ err: describe(error) }, "worker tick failed");
    } finally {
      this.#reconciling = false;
    }
  }

  /** Open what should be up, close what should not. */
  async #reconcileSessions(): Promise<void> {
    const wanted = await asService((q) => sessionsToRun(q));
    const wantedByAccount = new Map(wanted.map((s) => [s.account_id, s]));

    for (const accountId of [...this.#live.keys()]) {
      if (!wantedByAccount.has(accountId)) {
        this.#log.info({ accountId }, "session no longer wanted, closing socket");
        await this.stop(accountId);
      }
    }

    for (const session of wanted) {
      const live = this.#live.get(session.account_id);
      if (live && live.phone !== session.phone_e164) {
        // The subscriber re-linked a different number; the old socket's creds
        // belong to the old number and must not be reused.
        await this.stop(session.account_id);
      } else if (live) {
        continue;
      }
      await this.#open(session);
    }
  }

  async #open(session: SessionRow): Promise<void> {
    if (this.#live.has(session.account_id)) return;

    const auth = await useDbAuthState(session.id);
    this.#waVersion ??= await fetchLatestBaileysVersion()
      .then((r) => r.version)
      .catch(() => undefined);

    const sock = makeWASocket({
      auth: {
        creds: auth.state.creds,
        // The signal key store is hit hard during a handshake; without the cache
        // every pre-key lookup is a round trip to Postgres.
        keys: makeCacheableSignalKeyStore(auth.state.keys, silentLogger),
      },
      version: this.#waVersion,
      logger: silentLogger,
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      // We only care about messages arriving from now on. Pulling a subscriber's
      // entire history would mean holding years of their conversations in a
      // process that has no business seeing any of it.
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => false,
    });

    const live: Live = {
      sessionId: session.id,
      accountId: session.account_id,
      phone: session.phone_e164,
      sock,
      generation: 0,
      closing: false,
      reconnectAttempts: 0,
    };
    this.#live.set(session.account_id, live);

    sock.ev.on("creds.update", () => {
      void auth.saveCreds().catch((error: unknown) => {
        this.#log.error({ err: describe(error), sessionId: session.id }, "could not save creds");
      });
    });

    sock.ev.on("connection.update", (update) => {
      void this.#onConnectionUpdate(live, update, auth.registered).catch((error: unknown) => {
        this.#log.error({ err: describe(error), sessionId: session.id }, "connection update failed");
      });
    });

    sock.ev.on("messages.upsert", (upsert) => {
      if (upsert.type !== "notify") return;
      void this.#onMessages(live, upsert.messages).catch((error: unknown) => {
        this.#log.error({ err: describe(error), sessionId: session.id }, "message handling failed");
      });
    });

    sock.ev.on("call", (calls) => {
      void this.#onCalls(live, calls).catch((error: unknown) => {
        this.#log.error({ err: describe(error), sessionId: session.id }, "call handling failed");
      });
    });
  }

  async #onConnectionUpdate(
    live: Live,
    update: Partial<ConnectionState>,
    alreadyRegistered: boolean,
  ): Promise<void> {
    const { connection, lastDisconnect } = update;

    // Pairing code rather than QR: the subscriber gave us their number on the
    // landing page, and a code they can type beats a QR they would have to
    // photograph off a screen they are already holding.
    if (connection === "connecting" && !alreadyRegistered && !live.sock.authState.creds.registered) {
      await this.#requestPairingCode(live);
    }

    if (connection === "open") {
      live.reconnectAttempts = 0;
      live.generation += 1;
      const jid = live.sock.user?.id ?? "";
      await asService((q) => markLinked(q, live.sessionId, jid));
      this.#log.info(
        { accountId: live.accountId, phone: maskPhone(live.phone) },
        "WhatsApp connected",
      );
      return;
    }

    if (connection !== "close") return;

    // Baileys wraps disconnect causes in a Boom error; read the status
    // structurally rather than taking a dependency on @hapi/boom for one field.
    const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
      ?.output?.statusCode;
    const loggedOut = status === DisconnectReason.loggedOut;
    const reason = DisconnectReason[status as number] ?? `code ${status ?? "unknown"}`;
    await asService((q) => markDisconnected(q, live.sessionId, String(reason), loggedOut));

    if (live.closing) return;

    if (loggedOut) {
      // The subscriber removed us from Linked Devices, or WhatsApp did. The creds
      // are dead: reconnecting with them loops forever, so the session goes to
      // 'logged_out' and the dashboard asks them to pair again.
      this.#log.warn({ accountId: live.accountId }, "logged out by WhatsApp; not reconnecting");
      await this.stop(live.accountId);
      return;
    }

    this.#scheduleReconnect(live, String(reason));
  }

  #scheduleReconnect(live: Live, reason: string): void {
    this.#live.delete(live.accountId);
    live.reconnectAttempts += 1;
    // Capped exponential backoff. WhatsApp rate-limits reconnects, and a tight
    // loop across every subscriber at once is how one blip becomes an outage.
    const delay = Math.min(2 ** live.reconnectAttempts * 1000, 60_000);
    this.#log.warn(
      { accountId: live.accountId, reason, delayMs: delay },
      "WhatsApp disconnected; reconnecting",
    );
    live.reconnectTimer = setTimeout(() => {
      void (async () => {
        const session = await asService((q) => sessionById(q, live.sessionId));
        if (session && (session.status === "linked" || session.status === "pairing")) {
          await this.#open({ ...session, account_id: live.accountId });
        }
      })().catch((error: unknown) => {
        this.#log.error({ err: describe(error) }, "reconnect failed");
      });
    }, delay);
  }

  async #requestPairingCode(live: Live): Promise<void> {
    // Baileys wants a moment after the socket opens before it will mint one.
    await new Promise((r) => setTimeout(r, 3000));
    if (live.closing || live.sock.authState.creds.registered) return;
    try {
      const code = await live.sock.requestPairingCode(live.phone);
      await asService((q) => savePairingCode(q, live.sessionId, code, env.pairingCodeTtlSeconds));
      this.#log.info(
        { accountId: live.accountId, phone: maskPhone(live.phone) },
        "pairing code issued",
      );
    } catch (error) {
      this.#log.error(
        { err: describe(error), accountId: live.accountId },
        "WhatsApp refused a pairing code",
      );
      await asService((q) =>
        markDisconnected(q, live.sessionId, `pairing failed: ${describe(error).message}`, false),
      );
    }
  }

  // ------------------------------------------------------------ the filter

  async #policyFor(accountId: string): Promise<CachedPolicy> {
    const cached = this.#policy.get(accountId);
    if (cached && Date.now() - cached.loadedAt < POLICY_TTL_MS) return cached;
    const fresh = await asService(async (q) => ({
      rules: await activeRules(q, accountId),
      settings: toSettings(await getSettings(q, accountId)),
      loadedAt: Date.now(),
    }));
    this.#policy.set(accountId, fresh);
    return fresh;
  }

  async #onMessages(live: Live, messages: WAMessage[]): Promise<void> {
    const { rules, settings } = await this.#policyFor(live.accountId);

    for (const message of messages) {
      const remoteJid = message.key.remoteJid;
      if (!remoteJid) continue;

      const verdict = decide(
        {
          remoteJid,
          fromMe: Boolean(message.key.fromMe),
          participantJid: message.key.participant ?? undefined,
          isKnownContact: this.#isKnown(live, message.key.participant ?? remoteJid),
        },
        rules,
        settings,
      );

      // Our own traffic and non-conversations are the bulk of the stream and
      // recording them would drown the log the subscriber actually reads.
      if (verdict.decision === "skipped_self") continue;

      await this.#actOn(live, remoteJid, verdict, anchorFrom(message));
    }
  }

  /**
   * Whether the sender is in the subscriber's address book.
   *
   * Baileys only knows this once contacts have synced, and a fresh link has not
   * synced yet. Unknown therefore means "not known", which errs toward filtering
   * — so the default has `apply_to_known_contacts` off and the exemption only
   * ever adds safety once the sync has landed.
   */
  #isKnown(live: Live, jid: string): boolean {
    const store = (live.sock as unknown as { contacts?: Record<string, unknown> }).contacts;
    return Boolean(store && jid in store);
  }

  async #actOn(live: Live, remoteJid: string, verdict: Verdict, anchor: MessageAnchor): Promise<void> {
    if (verdict.decision !== "blocked") {
      await asService((q) =>
        recordEvent(q, {
          accountId: live.accountId,
          sessionId: live.sessionId,
          remoteJid,
          verdict,
        }),
      );
      return;
    }

    if (verdict.delaySeconds > 0) {
      await asService(async (q) => {
        await enqueuePending(q, {
          accountId: live.accountId,
          sessionId: live.sessionId,
          remoteJid,
          action: verdict.action,
          lastMessage: anchor,
          delaySeconds: verdict.delaySeconds,
        });
        await recordEvent(q, {
          accountId: live.accountId,
          sessionId: live.sessionId,
          remoteJid,
          verdict,
          actionTaken: null,
          detail: `queued ${verdict.action} in ${verdict.delaySeconds}s`,
        });
      });
      return;
    }

    await this.#carryOut(live.accountId, live.sessionId, remoteJid, verdict.action, anchor, verdict);
  }

  async #carryOut(
    accountId: string,
    sessionId: string,
    remoteJid: string,
    action: Verdict["action"],
    anchor: MessageAnchor,
    verdict: Verdict,
  ): Promise<void> {
    const live = this.#live.get(accountId);
    if (!live) throw new Error("no live socket for this account");

    const result = await applyAction(live.sock, remoteJid, action, anchor);
    await asService((q) =>
      recordEvent(q, {
        accountId,
        sessionId,
        remoteJid,
        verdict,
        actionTaken: result.done,
        detail: result.warnings.length ? result.warnings.join("; ") : null,
      }),
    );
    this.#log.info(
      { accountId, phone: maskPhone(verdict.phone), prefix: verdict.matchedPrefix, action },
      "filter enforced",
    );
  }

  /**
   * Held actions whose delay has run out.
   *
   * The armed check is repeated here rather than trusted from when the action
   * was queued. A subscriber who disarms during the delay is telling us to stop,
   * and a queue that acts on a decision made two minutes ago would ignore them.
   */
  async #drainPending(): Promise<void> {
    const due = await asService((q) => claimDuePending(q));

    for (const row of due) {
      const live = this.#live.get(row.account_id);
      const { settings } = await this.#policyFor(row.account_id).catch(() => ({
        settings: undefined as AccountSettings | undefined,
      }));

      if (!settings?.armed || settings.action === "log_only") {
        await asService((q) =>
          recordEvent(q, {
            accountId: row.account_id,
            sessionId: row.session_id,
            remoteJid: row.remote_jid,
            verdict: { decision: "would_block", isGroup: false },
            detail: "held action dropped: account disarmed during the delay",
          }),
        );
        continue;
      }

      if (!live) {
        if (row.attempts + 1 >= MAX_PENDING_ATTEMPTS) {
          await this.#recordPendingFailure(row, "no live socket after repeated attempts");
          continue;
        }
        await asService((q) => requeuePending(q, row, 30));
        continue;
      }

      try {
        await this.#carryOut(
          row.account_id,
          row.session_id,
          row.remote_jid,
          row.action,
          row.last_message as MessageAnchor,
          {
            decision: "blocked",
            action: row.action,
            delaySeconds: 0,
            isGroup: row.remote_jid.endsWith("@g.us"),
          },
        );
      } catch (error) {
        if (row.attempts + 1 >= MAX_PENDING_ATTEMPTS) {
          await this.#recordPendingFailure(row, describe(error).message);
          continue;
        }
        await asService((q) => requeuePending(q, row, 30));
      }
    }
  }

  async #recordPendingFailure(
    row: { account_id: string; session_id: string; remote_jid: string },
    detail: string,
  ): Promise<void> {
    await asService((q) =>
      recordEvent(q, {
        accountId: row.account_id,
        sessionId: row.session_id,
        remoteJid: row.remote_jid,
        verdict: { decision: "error", isGroup: false },
        detail,
      }),
    );
  }

  async #onCalls(
    live: Live,
    calls: { id: string; from: string; status: string }[],
  ): Promise<void> {
    const { rules, settings } = await this.#policyFor(live.accountId);
    for (const call of calls) {
      if (call.status !== "offer") continue;
      const outcome = decideCall(call.from, rules, settings);
      if (!outcome.reject) continue;
      try {
        await rejectCall(live.sock, call.id, call.from);
        await asService((q) =>
          recordEvent(q, {
            accountId: live.accountId,
            sessionId: live.sessionId,
            remoteJid: call.from,
            verdict: {
              decision: "blocked",
              phone: outcome.phone,
              matchedPrefix: outcome.matchedPrefix,
              matchedRuleId: outcome.matchedRuleId,
              isGroup: false,
            },
            detail: "call rejected",
          }),
        );
      } catch (error) {
        this.#log.warn({ err: describe(error), accountId: live.accountId }, "could not reject call");
      }
    }
  }

  /** Retention, once a day, from whichever worker gets there first. */
  async #purgeDaily(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.#lastPurgeDay === today) return;
    this.#lastPurgeDay = today;
    const removed = await asService((q) => purgeOldEvents(q, env.eventRetentionDays));
    if (removed > 0) this.#log.info({ removed }, "purged expired activity rows");
  }
}

function describe(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "unknown", message: String(error) };
}
