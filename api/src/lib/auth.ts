/**
 * Subscriber sessions.
 *
 * AUTH_MODE=dev mints a token from an email so the service runs without an
 * identity provider standing up. AUTH_MODE=external verifies tokens somebody
 * else minted and issues none, which is the production shape.
 */

import { SignJWT, jwtVerify } from "jose";
import { env, authMode } from "./env.ts";
import { unauthorized } from "./errors.ts";
import type { Claims } from "./db.ts";

const secret = () => new TextEncoder().encode(env.jwtSecret);

export async function mintSessionToken(userId: string): Promise<string> {
  if (authMode !== "dev") {
    throw new Error("session tokens are minted by the identity provider when AUTH_MODE=external");
  }
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(env.jwtIssuer)
    .setIssuedAt()
    .setExpirationTime(`${env.sessionTokenTtlHours}h`)
    .sign(secret());
}

export async function verifySessionToken(token: string): Promise<Claims> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: env.jwtIssuer });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("no subject");
    return { sub: payload.sub };
  } catch {
    throw unauthorized("session token is invalid or expired");
  }
}

export function bearerToken(header: string | undefined): string {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) throw unauthorized();
  return match[1]!;
}
