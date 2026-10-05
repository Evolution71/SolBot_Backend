import crypto from "crypto";

/**
 * Backs the "preview, then confirm with a button" trade flow: a user runs
 * /snipe or /sell, sees exactly what they'll pay (including the fee) and
 * what they'll receive, and only then taps Confirm to actually sign and
 * submit anything. This is both a trust feature (no surprises) and a
 * safety feature (catches fat-finger amounts/addresses before they cost
 * real money).
 *
 * Telegram callback_data is capped at 64 bytes, so we can't embed the full
 * trade details in the button itself — instead we store the pending trade
 * server-side keyed by a short random ID, and the button just carries that
 * ID.
 *
 * SCALING NOTE: this is an in-memory Map, which works for a single backend
 * instance. If you ever run more than one Railway instance/replica behind
 * a load balancer, move this to Supabase (a `pending_trades` table with an
 * expiry column) or Redis, since a confirm tap could land on a different
 * instance than the one that created the preview.
 */

export type PendingTrade =
  | {
      kind: "buy";
      telegramUserId: string;
      tokenMint: string;
      solAmount: number;
      feeBps: number;
      takeProfitPct?: number | null;
      stopLossPct?: number | null;
    }
  | {
      kind: "sell";
      telegramUserId: string;
      tokenMint: string;
      percent: number;
      feeBps: number;
    };

interface StoredEntry {
  trade: PendingTrade;
  expiresAt: number;
}

const TTL_MS = 2 * 60 * 1000; // trade previews are only valid for 2 minutes — prices move fast
const store = new Map<string, StoredEntry>();

function cleanup() {
  const now = Date.now();
  for (const [id, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(id);
  }
}

export function createPendingTrade(trade: PendingTrade): string {
  cleanup();
  const id = crypto.randomBytes(6).toString("hex");
  store.set(id, { trade, expiresAt: Date.now() + TTL_MS });
  return id;
}

export function consumePendingTrade(id: string, requestingTelegramUserId: string): PendingTrade | null {
  cleanup();
  const entry = store.get(id);
  if (!entry) return null;
  if (entry.trade.telegramUserId !== requestingTelegramUserId) return null; // not this user's trade

  store.delete(id); // one-time use — prevents double-tap replay
  return entry.trade;
}

export function discardPendingTrade(id: string): void {
  store.delete(id);
}
