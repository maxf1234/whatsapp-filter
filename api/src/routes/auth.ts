/** Signup and session tokens. */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { authMode } from "../lib/env.ts";
import { mintSessionToken } from "../lib/auth.ts";
import { signUp } from "../domain/accounts.ts";
import { principal } from "../lib/http.ts";
import { asPrincipal } from "../lib/db.ts";
import { getSettings } from "../domain/accounts.ts";
import { currentSession } from "../domain/linking.ts";
import { forbidden } from "../lib/errors.ts";

const signUpBody = z.object({
  email: z.string().email(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The landing page's one button. In dev mode it returns a usable token so the
   * whole flow works end to end on a laptop; in external mode it creates the
   * account and leaves authentication to the identity provider, because minting
   * a session from an email alone is exactly the hole AUTH_MODE exists to close.
   */
  app.post("/v1/signup", async (request) => {
    const { email } = signUpBody.parse(request.body);
    const account = await signUp(email);
    return {
      account_id: account.account_id,
      email: account.email,
      token: authMode === "dev" ? await mintSessionToken(account.user_id) : null,
      auth_mode: authMode,
    };
  });

  app.post("/v1/sessions", async (request) => {
    if (authMode !== "dev") {
      throw forbidden("sign in with the identity provider when AUTH_MODE=external");
    }
    const { email } = signUpBody.parse(request.body);
    const account = await signUp(email);
    return { token: await mintSessionToken(account.user_id), account_id: account.account_id };
  });

  /** Everything the dashboard needs to render its first frame in one round trip. */
  app.get("/v1/me", async (request) => {
    const who = await principal(request);
    return asPrincipal(who.claims, async (q) => {
      const [settings, session] = await Promise.all([
        getSettings(q, who.accountId),
        currentSession(q, who.accountId),
      ]);
      return {
        account_id: who.accountId,
        email: who.email,
        role: who.role,
        settings,
        session: session
          ? {
              id: session.id,
              phone_e164: session.phone_e164,
              status: session.status,
              linked_at: session.linked_at,
              last_connected_at: session.last_connected_at,
              last_disconnect_reason: session.last_disconnect_reason,
            }
          : null,
      };
    });
  });
}
