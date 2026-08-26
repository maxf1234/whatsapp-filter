/**
 * What we are willing to write down.
 *
 * This service sees people's private conversations. It logs that a message
 * arrived, from which number, and what was decided — never the message. The
 * redaction is here rather than at each call site so a future route cannot log
 * a body by forgetting.
 */

const SENSITIVE = new Set([
  "message", "text", "caption", "conversation", "body",
  "pairing_code", "pairingCode", "token", "authorization", "creds", "ciphertext",
]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE.has(key) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

/** A phone number in a log line, shortened so a leaked log is not a contact list. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "unknown";
  return phone.length <= 6 ? `+${phone}` : `+${phone.slice(0, 4)}…${phone.slice(-2)}`;
}
