/**
 * Baileys' AuthenticationState, kept in Postgres instead of on disk.
 *
 * `useMultiFileAuthState` writes a directory per session, which is fine for one
 * bot and wrong for a service: a multi-tenant worker on a container filesystem
 * would lose every subscriber's login on redeploy, and two replicas would each
 * hold half the sessions. In Postgres the state outlives the container, and a
 * replacement worker picks up the same links.
 *
 * Values are AES-256-GCM sealed on the way in (lib/crypto.ts). Baileys hands us
 * Buffers and expects Buffers back, which JSON does not carry, so BufferJSON's
 * replacer/reviver do the round trip — the same pair Baileys' own file store uses.
 */

import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "@whiskeysockets/baileys";
import { asService } from "../lib/db.ts";
import { seal, open } from "../lib/crypto.ts";

type KeyType = keyof SignalDataTypeMap;

async function readValue(sessionId: string, key: string): Promise<unknown> {
  const row = await asService(async (q) => {
    const result = await q.query<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(
      `select ciphertext, iv, auth_tag from session_auth_state where session_id = $1 and key = $2`,
      [sessionId, key],
    );
    return result.rows[0];
  });
  if (!row) return undefined;
  const plaintext = open({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag });
  return JSON.parse(plaintext.toString("utf8"), BufferJSON.reviver);
}

async function writeValues(sessionId: string, entries: [string, unknown][]): Promise<void> {
  if (entries.length === 0) return;
  await asService(async (q) => {
    for (const [key, value] of entries) {
      if (value === null || value === undefined) {
        await q.query(`delete from session_auth_state where session_id = $1 and key = $2`, [
          sessionId,
          key,
        ]);
        continue;
      }
      const sealed = seal(Buffer.from(JSON.stringify(value, BufferJSON.replacer), "utf8"));
      await q.query(
        `insert into session_auth_state (session_id, key, ciphertext, iv, auth_tag, updated_at)
         values ($1,$2,$3,$4,$5, now())
         on conflict (session_id, key) do update
            set ciphertext = excluded.ciphertext,
                iv         = excluded.iv,
                auth_tag   = excluded.auth_tag,
                updated_at = now()`,
        [sessionId, key, sealed.ciphertext, sealed.iv, sealed.authTag],
      );
    }
  });
}

export interface DbAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** True when this session has completed a handshake before and should not be asked to pair again. */
  registered: boolean;
}

export async function useDbAuthState(sessionId: string): Promise<DbAuthState> {
  const creds = ((await readValue(sessionId, "creds")) as AuthenticationCreds | undefined)
    ?? initAuthCreds();

  return {
    registered: Boolean(creds.registered),
    state: {
      creds,
      keys: {
        get: async <T extends KeyType>(type: T, ids: string[]) => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readValue(sessionId, `${type}-${id}`);
              // App-state sync keys are the one type Baileys wants back as a
              // decoded protobuf rather than the plain object we stored.
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
              }
              if (value !== undefined) out[id] = value as SignalDataTypeMap[T];
            }),
          );
          return out;
        },
        set: async (data) => {
          const entries: [string, unknown][] = [];
          for (const [type, byId] of Object.entries(data)) {
            for (const [id, value] of Object.entries(byId ?? {})) {
              entries.push([`${type}-${id}`, value]);
            }
          }
          await writeValues(sessionId, entries);
        },
      },
    },
    saveCreds: async () => {
      await writeValues(sessionId, [["creds", creds]]);
    },
  };
}
