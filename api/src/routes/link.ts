/** Pairing a subscriber's WhatsApp, and taking it back off. */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { asPrincipal, asService } from "../lib/db.ts";
import { principal } from "../lib/http.ts";
import { normalizePhone } from "../domain/phone.ts";
import { currentSession, requestLink, revokeSession } from "../domain/linking.ts";
import { badRequest, forbidden } from "../lib/errors.ts";
import type { SessionManager } from "../worker/sessionManager.ts";

// Deliberately loose: anything short of empty gets past Zod so the specific
// `invalid_phone` error comes from normalizePhone, which is the one the pairing
// screen knows how to explain. A generic "failed validation" here would be worse.
const linkBody = z.object({ phone: z.string().min(1).max(32) });

export async function linkRoutes(app: FastifyInstance, opts: { manager?: SessionManager }): Promise<void> {
  /**
   * Start pairing. Writes the intent and returns immediately — the pairing code
   * comes back from GET /v1/link, because asking WhatsApp for one takes as long
   * as it takes and a subscriber staring at a spinner should be staring at our
   * spinner, not at a socket timeout.
   */
  app.post("/v1/link", async (request) => {
    const who = await principal(request);
    if (who.role !== "owner") throw forbidden("only the account owner can link a number");

    const phone = normalizePhone(linkBody.parse(request.body).phone);
    if (!phone) throw badRequest("that does not look like a full international number", "invalid_phone");

    const session = await asService((q) => requestLink(q, who.accountId, phone));
    // Nudge the worker so the code arrives in seconds rather than at the next tick.
    opts.manager?.reconcileSoon();

    return {
      session_id: session.id,
      phone_e164: session.phone_e164,
      status: session.status,
      // Null on the first call by design; the dashboard polls for it.
      pairing_code: session.pairing_code,
    };
  });

  /** Polled by the pairing screen. */
  app.get("/v1/link", async (request) => {
    const who = await principal(request);
    return asPrincipal(who.claims, async (q) => {
      const session = await currentSession(q, who.accountId);
      if (!session) return { status: "none" as const };
      const expired =
        session.pairing_expires_at !== null && new Date(session.pairing_expires_at) < new Date();
      return {
        session_id: session.id,
        status: session.status,
        phone_e164: session.phone_e164,
        // A code past its expiry is not shown at all: displaying one that
        // WhatsApp will reject reads as "the product is broken".
        pairing_code: expired ? null : session.pairing_code,
        pairing_expires_at: session.pairing_expires_at,
        linked_at: session.linked_at,
        last_connected_at: session.last_connected_at,
        last_disconnect_reason: session.last_disconnect_reason,
      };
    });
  });

  app.delete("/v1/link", async (request, reply) => {
    const who = await principal(request);
    if (who.role !== "owner") throw forbidden("only the account owner can unlink");
    const removed = await asService((q) => revokeSession(q, who.accountId));
    await opts.manager?.stop(who.accountId);
    reply.code(removed ? 200 : 404);
    return { unlinked: removed };
  });
}
