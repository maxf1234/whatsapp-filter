/** Rules, the dial-plan picker behind them, and the settings that arm them. */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { asPrincipal, many } from "../lib/db.ts";
import { principal } from "../lib/http.ts";
import {
  createRule, createRules, deleteRule, listRules, normalizePrefix, updateRule,
} from "../domain/rules.ts";
import { getSettings, updateSettings } from "../domain/accounts.ts";
import { forbidden } from "../lib/errors.ts";
import type { SessionManager } from "../worker/sessionManager.ts";

const kind = z.enum(["block", "allow"]);

const createBody = z.object({
  prefix: z.string().min(1).max(20),
  kind: kind.default("block"),
  label: z.string().max(120).optional(),
  /** Set by the picker's NANP tab so a bare "917" means the area code, not the prefix 917. */
  area_code: z.boolean().default(false),
});

const bulkBody = z.object({
  prefixes: z.array(z.string().min(1).max(20)).min(1).max(500),
  kind: kind.default("block"),
  area_code: z.boolean().default(false),
});

const patchBody = z.object({
  kind: kind.optional(),
  label: z.string().max(120).nullable().optional(),
  enabled: z.boolean().optional(),
});

const settingsBody = z.object({
  action: z.enum(["log_only", "archive", "delete", "block_and_delete"]).optional(),
  armed: z.boolean().optional(),
  delete_delay_seconds: z.number().int().min(0).max(86400).optional(),
  apply_to_known_contacts: z.boolean().optional(),
  apply_to_groups: z.boolean().optional(),
  reject_calls: z.boolean().optional(),
});

export async function ruleRoutes(app: FastifyInstance, opts: { manager?: SessionManager }): Promise<void> {
  app.get("/v1/rules", async (request) => {
    const who = await principal(request);
    return asPrincipal(who.claims, async (q) => ({ rules: await listRules(q, who.accountId) }));
  });

  app.post("/v1/rules", async (request, reply) => {
    const who = await principal(request);
    if (who.role !== "owner") throw forbidden("only the account owner can change rules");
    const body = createBody.parse(request.body);
    const prefix = normalizePrefix(body.prefix, body.area_code);
    const rule = await asPrincipal(who.claims, (q) =>
      createRule(q, who.accountId, { kind: body.kind, prefix, label: body.label ?? null }),
    );
    opts.manager?.invalidateRules(who.accountId);
    reply.code(201);
    return { rule };
  });

  app.post("/v1/rules/bulk", async (request) => {
    const who = await principal(request);
    if (who.role !== "owner") throw forbidden("only the account owner can change rules");
    const body = bulkBody.parse(request.body);
    const prefixes = body.prefixes.map((p) => normalizePrefix(p, body.area_code));
    const result = await asPrincipal(who.claims, (q) =>
      createRules(q, who.accountId, body.kind, prefixes),
    );
    opts.manager?.invalidateRules(who.accountId);
    return result;
  });

  app.patch("/v1/rules/:id", async (request) => {
    const who = await principal(request);
    if (who.role !== "owner") throw forbidden("only the account owner can change rules");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rule = await asPrincipal(who.claims, (q) => updateRule(q, id, patchBody.parse(request.body)));
    opts.manager?.invalidateRules(who.accountId);
    return { rule };
  });

  app.delete("/v1/rules/:id", async (request) => {
    const who = await principal(request);
    if (who.role !== "owner") throw forbidden("only the account owner can change rules");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await asPrincipal(who.claims, (q) => deleteRule(q, id));
    opts.manager?.invalidateRules(who.accountId);
    return { deleted: true };
  });

  app.get("/v1/settings", async (request) => {
    const who = await principal(request);
    return asPrincipal(who.claims, async (q) => ({ settings: await getSettings(q, who.accountId) }));
  });

  /**
   * Arming lives here rather than behind its own verb because it is a setting,
   * not an event — but it is the setting that turns an irreversible action on,
   * so the response echoes the whole state back and the dashboard shows it.
   */
  app.patch("/v1/settings", async (request) => {
    const who = await principal(request);
    if (who.role !== "owner") throw forbidden("only the account owner can change settings");
    const body = settingsBody.parse(request.body);
    const settings = await asPrincipal(who.claims, (q) =>
      updateSettings(q, who.accountId, {
        action: body.action,
        armed: body.armed,
        deleteDelaySeconds: body.delete_delay_seconds,
        applyToKnownContacts: body.apply_to_known_contacts,
        applyToGroups: body.apply_to_groups,
        rejectCalls: body.reject_calls,
      }),
    );
    opts.manager?.invalidateRules(who.accountId);
    return { settings };
  });

  /** The picker's data. Public reference, no principal needed beyond a session. */
  app.get("/v1/dial-prefixes", async (request) => {
    const who = await principal(request);
    const query = z
      .object({ kind: z.enum(["country", "nanp_area"]).optional(), q: z.string().max(60).optional() })
      .parse(request.query);
    return asPrincipal(who.claims, async (q) => ({
      prefixes: await many(
        q,
        `select prefix, kind, name, region from dial_prefixes
          where ($1::dial_prefix_kind is null or kind = $1)
            and ($2::text is null or name ilike '%' || $2 || '%' or prefix like $2 || '%')
          order by kind, name, prefix
          limit 1000`,
        [query.kind ?? null, query.q ?? null],
      ),
    }));
  });
}
