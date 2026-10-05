import { supabase } from "../db/supabase";

export interface RecordTradeInput {
  telegramUserId: string;
  tokenMint: string;
  side: "buy" | "sell";
  solAmount: number;
  txSignature: string;
  /** Raw base-unit token amount moved by the swap (out-amount on a buy,
   * in-amount on a sell) — required for accurate FIFO PNL. */
  tokenAmountRaw: number;
  tokenDecimals: number;
}

export async function recordTrade(input: RecordTradeInput) {
  const { error } = await supabase.from("trades").insert({
    telegram_user_id: input.telegramUserId,
    token_mint: input.tokenMint,
    side: input.side,
    sol_amount: input.solAmount,
    token_amount_raw: input.tokenAmountRaw,
    token_decimals: input.tokenDecimals,
    tx_signature: input.txSignature,
  });
  if (error) throw error;
}

export async function getRecentTrades(telegramUserId: string, limit = 10) {
  const { data, error } = await supabase
    .from("trades")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

export interface TradeSummary {
  totalTrades: number;
  solBought: number;
  solSold: number;
  netSolFlow: number;
}

/**
 * Volume summary for a user (trade counts, gross SOL in/out). This is NOT
 * PNL — see pnlService.getPortfolioPnl for FIFO-matched realized/unrealized
 * PNL, which is what /share and the dashboard should show as "profit."
 */
export async function getTradeSummary(telegramUserId: string): Promise<TradeSummary> {
  const { data, error } = await supabase
    .from("trades")
    .select("side, sol_amount")
    .eq("telegram_user_id", telegramUserId);
  if (error) throw error;

  const bought = (data ?? [])
    .filter((t) => t.side === "buy")
    .reduce((sum, t) => sum + Number(t.sol_amount), 0);
  const sold = (data ?? [])
    .filter((t) => t.side === "sell")
    .reduce((sum, t) => sum + Number(t.sol_amount), 0);

  return {
    totalTrades: data?.length ?? 0,
    solBought: bought,
    solSold: sold,
    netSolFlow: sold - bought,
  };
}
