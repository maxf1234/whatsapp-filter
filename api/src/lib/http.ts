/** Request plumbing shared by every route: who is calling, and what account they act on. */

import type { FastifyRequest } from "fastify";
import { bearerToken, verifySessionToken } from "./auth.ts";
import { accountForUser } from "../domain/accounts.ts";
import type { Claims } from "./db.ts";

export interface Principal {
  claims: Claims;
  accountId: string;
  role: "owner" | "member";
  email: string;
}

export async function principal(request: FastifyRequest): Promise<Principal> {
  const claims = await verifySessionToken(bearerToken(request.headers.authorization));
  const account = await accountForUser(claims.sub);
  return {
    claims,
    accountId: account.account_id,
    role: account.role,
    email: account.email,
  };
}
