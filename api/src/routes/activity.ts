/** The activity log, and the escape hatch for a delete that has not happened yet. */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { asPrincipal } from "../lib/db.ts";
import { principal } from "../lib/http.ts";
import { cancelPending, eventSummary, listEvents, listPending } from "../domain/activity.ts";
import { forbidden, notFound } from "../lib/errors.ts";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().datetime().optional(),
  decision: z
    .enum([
      "blocked", "would_block", "allowed", "no_match", "skipped_group",
      "skipped_known", "skipped_self", "unresolved_jid", "error",
    ])
    .optional(),
});

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/activity", async (request) => {
    const who = await principal(request);
    const query = listQuery.parse(request.query);
    return asPrincipal(who.claims, async (q) => ({
      events: await listEvents(q, who.accountId, query),
      summary: await eventSummary(q, who.accountId),
    }));
  });

  /**
   * Chats matched and waiting out their delete delay. This is the screen that
   * makes the delay worth having: a subscriber who has just armed a rule that
   * matches their sister can see the pending row and cancel it.
   */
  app.get("/v1/pending", async (request) => {
    const who = await principal(request);
    return asPrincipal(who.claims, async (q) => ({
      pending: (await listPending(q, who.accountId)).map((p) => ({
        id: p.id,
        remote_jid: p.remote_jid,
        action: p.action,
        due_at: p.due_at,
      })),
    }));
  });

  app.delete("/v1/pending/:id", async (request) => {
    const who = await principal(request);
    if (who.role !== "owner") throw forbidden("only the account owner can cancel");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const cancelled = await asPrincipal(who.claims, (q) => cancelPending(q, id));
    if (!cancelled) throw notFound("nothing pending with that id");
    return { cancelled: true };
  });
}
