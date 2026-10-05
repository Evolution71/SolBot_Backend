import { supabase } from "../db/supabase";
import { getQuote, SOL_MINT, sellToken } from "./jupiterService";
import { loadSigningKeypair } from "./walletService";
import { recordTrade } from "./tradeService";
import { getEffectiveFeeBps } from "./feeTierService";
import { captureException } from "./monitoringService";
import { logger } from "../utils/logger";

export interface OpenPositionInput {
  telegramUserId: string;
  tokenMint: string;
  entrySolAmount: number;
  entryTokenAmountRaw: number;
  tokenDecimals: number;
  takeProfitPct?: number | null;
  stopLossPct?: number | null;
  openedVia: "manual" | "autopilot" | "watch";
}

export async function openPosition(input: OpenPositionInput): Promise<void> {
  if (input.takeProfitPct == null && input.stopLossPct == null) return; // nothing to monitor

  const { error } = await supabase.from("positions").insert({
    telegram_user_id: input.telegramUserId,
    token_mint: input.tokenMint,
    entry_sol_amount: input.entrySolAmount,
    entry_token_amount_raw: input.entryTokenAmountRaw,
    token_decimals: input.tokenDecimals,
    take_profit_pct: input.takeProfitPct,
    stop_loss_pct: input.stopLossPct,
    opened_via: input.openedVia,
    status: "open",
  });
  if (error) throw error;
}

export type TriggerDecision = "hold" | "take_profit" | "stop_loss";

/**
 * Pure decision function, unit-testable without touching the network:
 * given what was originally spent and what the position is worth right
 * now, decides whether a configured take-profit or stop-loss should fire.
 * Take-profit is checked before stop-loss so a position that gapped past
 * both thresholds in one move is recorded as a win, not a loss.
 */
export function decideTrigger(params: {
  entrySolAmount: number;
  currentValueSol: number;
  takeProfitPct: number | null;
  stopLossPct: number | null;
}): TriggerDecision {
  const { entrySolAmount, currentValueSol, takeProfitPct, stopLossPct } = params;

  if (takeProfitPct != null) {
    const targetValue = entrySolAmount * (1 + takeProfitPct / 100);
    if (currentValueSol >= targetValue) return "take_profit";
  }

  if (stopLossPct != null) {
    const floorValue = entrySolAmount * (1 - stopLossPct / 100);
    if (currentValueSol <= floorValue) return "stop_loss";
  }

  return "hold";
}

interface PositionRow {
  id: string;
  telegram_user_id: string;
  token_mint: string;
  entry_sol_amount: number;
  entry_token_amount_raw: number;
  token_decimals: number;
  take_profit_pct: number | null;
  stop_loss_pct: number | null;
}

async function closePosition(row: PositionRow, decision: "take_profit" | "stop_loss") {
  const keypair = await loadSigningKeypair(row.telegram_user_id);
  const fee = await getEffectiveFeeBps(row.telegram_user_id);

  const result = await sellToken({
    keypair,
    tokenMint: row.token_mint,
    tokenAmountRaw: row.entry_token_amount_raw,
    feeBps: fee.feeBps,
  });

  await recordTrade({
    telegramUserId: row.telegram_user_id,
    tokenMint: row.token_mint,
    side: "sell",
    solAmount: Number(result.outAmount) / 1_000_000_000,
    txSignature: result.signature,
    tokenAmountRaw: row.entry_token_amount_raw,
    tokenDecimals: row.token_decimals,
  });

  await supabase
    .from("positions")
    .update({
      status: decision === "take_profit" ? "closed_tp" : "closed_sl",
      close_tx_signature: result.signature,
      closed_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  logger.info(
    { telegramUserId: row.telegram_user_id, tokenMint: row.token_mint, decision, signature: result.signature },
    "Auto-closed a monitored position"
  );
}

/**
 * Runs on a timer (see index.ts). Checks every open monitored position's
 * current market value against its take-profit/stop-loss targets and
 * closes any that have been hit. Deliberately processes positions
 * sequentially rather than in parallel to avoid hammering the RPC/Jupiter
 * API with a burst of simultaneous requests as the user base grows.
 */
export async function checkOpenPositions(): Promise<void> {
  const { data: rows, error } = await supabase.from("positions").select("*").eq("status", "open");

  if (error) {
    captureException(error, { context: "position_monitor_fetch" });
    return;
  }
  if (!rows || rows.length === 0) return;

  for (const row of rows as PositionRow[]) {
    try {
      const quote = await getQuote(row.token_mint, SOL_MINT, row.entry_token_amount_raw);
      const currentValueSol = Number(quote.outAmount) / 1_000_000_000;

      const decision = decideTrigger({
        entrySolAmount: row.entry_sol_amount,
        currentValueSol,
        takeProfitPct: row.take_profit_pct,
        stopLossPct: row.stop_loss_pct,
      });

      if (decision !== "hold") {
        await closePosition(row, decision);
      }
    } catch (err) {
      // A single failed price check (e.g. a token whose liquidity vanished)
      // should not stop the rest of the batch from being checked.
      captureException(err, { context: "position_monitor_check", positionId: row.id, tokenMint: row.token_mint });
    }
  }
}
