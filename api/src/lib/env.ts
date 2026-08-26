/** Configuration, read once at startup so a missing value fails the boot rather than the first request. */

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://app:app@127.0.0.1:5432/wafilter_dev",
  port: optionalInt("PORT", 8080),
  host: process.env.HOST ?? "0.0.0.0",

  jwtSecret: process.env.JWT_SECRET ?? "dev-only-insecure-secret-change-me",
  jwtIssuer: process.env.JWT_ISSUER ?? "whatsapp-filter",
  sessionTokenTtlHours: optionalInt("SESSION_TOKEN_TTL_HOURS", 24 * 14),

  /** False runs the HTTP API alone, for splitting web and worker onto separate services. */
  runWorker: optionalBool("RUN_WORKER", true),

  /** How often the worker sweeps pending_actions and reconciles its sockets. */
  workerTickSeconds: optionalInt("WORKER_TICK_SECONDS", 20),

  /** A pairing code WhatsApp issued is good for a few minutes; we stop showing ours in step. */
  pairingCodeTtlSeconds: optionalInt("PAIRING_CODE_TTL_SECONDS", 180),

  /** Activity rows older than this are swept nightly. Nothing downstream depends on them. */
  eventRetentionDays: optionalInt("EVENT_RETENTION_DAYS", 90),

  webRoot: process.env.WEB_ROOT ?? "",
} as const;

/**
 * "dev" mints a session from an email alone and exists so the service is runnable
 * without an identity provider. "external" verifies tokens minted by one and
 * issues none. Production refuses to boot in dev mode.
 */
export const authMode: "dev" | "external" =
  process.env.AUTH_MODE === "external" ? "external" : "dev";

export function assertSafeBootConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (authMode === "dev") {
    throw new Error("AUTH_MODE=dev cannot be used in production: any email would mint a session");
  }
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET must be set in production");
  }
  // Read live rather than from `env`: lib/crypto.ts owns this key and reads it
  // the same way, and a boot check against a stale snapshot would pass while the
  // thing it is checking is unset.
  if (!process.env.SESSION_ENCRYPTION_KEY) {
    throw new Error(
      "SESSION_ENCRYPTION_KEY must be set in production: it is the only thing standing " +
        "between a database dump and every subscriber's WhatsApp account",
    );
  }
}
