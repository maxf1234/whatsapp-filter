/**
 * Carrying out a verdict on a live socket.
 *
 * Every action here is expressed against WhatsApp's own app-state sync, which
 * means it takes effect on the subscriber's phone and on every device they have
 * linked, exactly as if they had done it by hand. That is the point — this
 * service is not a proxy in front of WhatsApp, it is a device acting for them.
 *
 * It is also why `delete` is worth being careful about: WhatsApp has no undo,
 * and this deletes the conversation on their phone, not just here.
 */

import type { WASocket, WAMessageKey } from "@whiskeysockets/baileys";
import type { FilterAction } from "../domain/decide.ts";

/** The minimum WhatsApp needs to address a conversation in an app-state action. */
export interface MessageAnchor {
  key: WAMessageKey;
  messageTimestamp: number;
}

export function anchorFrom(message: {
  key: WAMessageKey;
  messageTimestamp?: number | Long | null;
}): MessageAnchor {
  const raw = message.messageTimestamp;
  const timestamp =
    typeof raw === "number"
      ? raw
      : raw && typeof raw === "object" && "toNumber" in raw
        ? (raw as { toNumber(): number }).toNumber()
        : Math.floor(Date.now() / 1000);
  return { key: message.key, messageTimestamp: timestamp };
}

interface Long {
  toNumber(): number;
}

/**
 * Applies one action to one chat. Returns what was actually done, which can be
 * less than what was asked when WhatsApp refuses a part of it — a block that
 * fails should not stop the delete that was the point of `block_and_delete`.
 */
export async function applyAction(
  sock: WASocket,
  jid: string,
  action: FilterAction,
  anchor: MessageAnchor,
): Promise<{ done: FilterAction; warnings: string[] }> {
  const warnings: string[] = [];
  const lastMessages = [{ key: anchor.key, messageTimestamp: anchor.messageTimestamp }];

  if (action === "log_only") return { done: action, warnings };

  if (action === "archive") {
    // Read first, then archive: an archived chat that still carries an unread
    // badge is the one outcome that is worse than doing nothing, because the
    // subscriber goes looking for it.
    await sock.chatModify({ markRead: true, lastMessages }, jid).catch((e: unknown) => {
      warnings.push(`markRead: ${message(e)}`);
    });
    await sock.chatModify({ mute: 8 * 60 * 60 * 1000 }, jid).catch((e: unknown) => {
      warnings.push(`mute: ${message(e)}`);
    });
    await sock.chatModify({ archive: true, lastMessages }, jid);
    return { done: action, warnings };
  }

  if (action === "block_and_delete") {
    // Block before delete. The other order leaves a window where the chat is
    // gone but the sender can still write into a fresh one.
    await sock.updateBlockStatus(jid, "block").catch((e: unknown) => {
      warnings.push(`block: ${message(e)}`);
    });
  }

  await sock.chatModify({ delete: true, lastMessages }, jid);
  return { done: action, warnings };
}

export async function rejectCall(sock: WASocket, callId: string, callFrom: string): Promise<void> {
  await sock.rejectCall(callId, callFrom);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
