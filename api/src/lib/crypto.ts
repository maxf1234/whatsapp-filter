/**
 * Envelope encryption for the WhatsApp credentials in session_auth_state.
 *
 * AES-256-GCM, a fresh 12-byte IV per write, tag stored alongside. The key comes
 * from SESSION_ENCRYPTION_KEY as 64 hex characters or 44 base64 ones.
 *
 * In development the key may be absent, and then this degrades to storing the
 * plaintext with a marker rather than refusing to run — a developer without a
 * key gets a working local service, and `assertSafeBootConfig` makes sure that
 * state can never reach production.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Marks a row written without a key, so decrypting one later fails loudly instead of returning noise. */
const PLAINTEXT_MARKER = Buffer.from("no-encryption-key");

let cachedKey: Buffer | null | undefined;

/**
 * Read from process.env rather than the `env` module: `env` snapshots the
 * environment at import, and this module is imported before anything that might
 * load a .env file. Reading here means the key is whatever is actually set at
 * the moment the first credential is written.
 */
function key(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.SESSION_ENCRYPTION_KEY ?? "";
  if (!raw) return (cachedKey = null);
  const parsed = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (parsed.length !== 32) {
    throw new Error("SESSION_ENCRYPTION_KEY must decode to 32 bytes (64 hex or 44 base64 chars)");
  }
  return (cachedKey = parsed);
}

/** Test hook: the key is read once and cached, and tests need to change it. */
export function resetKeyCache(): void {
  cachedKey = undefined;
}

export function seal(plaintext: Buffer): Sealed {
  const k = key();
  if (!k) return { ciphertext: plaintext, iv: Buffer.alloc(0), authTag: PLAINTEXT_MARKER };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function open(sealed: Sealed): Buffer {
  if (sealed.authTag.equals(PLAINTEXT_MARKER)) {
    if (key()) {
      throw new Error(
        "session_auth_state row was written without SESSION_ENCRYPTION_KEY; unlink and re-pair",
      );
    }
    return sealed.ciphertext;
  }
  const k = key();
  if (!k) throw new Error("SESSION_ENCRYPTION_KEY is required to read this session");
  const decipher = createDecipheriv("aes-256-gcm", k, sealed.iv);
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}
