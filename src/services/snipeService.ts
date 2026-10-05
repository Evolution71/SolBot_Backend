import { supabase } from "../db/supabase";
import { loadSigningKeypair, getTokenBalanceRaw } from "./walletService";
import { buyToken, sellToken, isValidMint, getMintDecimals } from "./jupiterService";
import { recordTrade } from "./tradeService";
import { logger } from "../utils/logger";
import { captureException } from "./monitoringService";
import { getEffectiveFeeBps } from "./feeTierService";
import { openPosition } from "./positionMonitorService";
import { config } from "../config";

export interface SnipeRequest {
  telegramUserId: string;
  tokenMint: string;
  solAmount: number;
  slippageBps?: number;
  takeProfitPct?: number | null;
  stopLossPct?: number | null;
}

async function getUserRiskSettings(telegramUserId: string) {
  const { data } = await supabase
    .from("users")
    .select("slippage_bps, max_price_impact_pct")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  return {
    slippageBps: data?.slippage_bps ?? config.solana.defaultSlippageBps,
    maxPriceImpactPct: data?.max_price_impact_pct ?? config.mev.maxPriceImpactPctDefault,
  };
}

/**
 * Manual /snipe <CA> <amount> — buys immediately, at the user's effective
 * (possibly discounted) fee rate.
 */
export async function manualSnipe(req: SnipeRequest) {
  if (!isValidMint(req.tokenMint)) {
    throw new Error("That doesn't look like a valid Solana token address.");
  }

  const [risk, fee] = await Promise.all([
    getUserRiskSettings(req.telegramUserId),
    getEffectiveFeeBps(req.telegramUserId),
  ]);
  const keypair = await loadSigningKeypair(req.telegramUserId);

  const result = await buyToken({
    keypair,
    tokenMint: req.tokenMint,
    solAmount: req.solAmount,
    slippageBps: req.slippageBps ?? risk.slippageBps,
    maxPriceImpactPct: risk.maxPriceImpactPct,
    feeBps: fee.feeBps,
  });

  await recordTrade({
    telegramUserId: req.telegramUserId,
    tokenMint: req.tokenMint,
    side: "buy",
    solAmount: req.solAmount,
    txSignature: result.signature,
    tokenAmountRaw: Number(result.outAmount),
    tokenDecimals: result.outputDecimals,
  });

  if (req.takeProfitPct != null || req.stopLossPct != null) {
    await openPosition({
      telegramUserId: req.telegramUserId,
      tokenMint: req.tokenMint,
      entrySolAmount: req.solAmount,
      entryTokenAmountRaw: Number(result.outAmount),
      tokenDecimals: result.outputDecimals,
      takeProfitPct: req.takeProfitPct,
      stopLossPct: req.stopLossPct,
      openedVia: "manual",
    });
  }

  return result;
}

export interface SellRequest {
  telegramUserId: string;
  tokenMint: string;
  /** 1-100. Sells this percentage of the wallet's current holding of the token. */
  percent: number;
}

/**
 * Pure helper, split out for unit testing: given a raw on-chain balance and
 * a requested percentage, returns the raw amount to sell. Floors rather
 * than rounds so we never attempt to sell more than the wallet holds.
 */
export function computeSellAmountRaw(balanceRaw: number, percent: number): number {
  return Math.floor(balanceRaw * (percent / 100));
}

/**
 * /sell <CA> <percent> — sells a percentage of the user's current holding,
 * at the user's effective (possibly discounted) fee rate.
 */
export async function manualSell(req: SellRequest) {
  if (!isValidMint(req.tokenMint)) {
    throw new Error("That doesn't look like a valid Solana token address.");
  }
  if (!Number.isFinite(req.percent) || req.percent <= 0 || req.percent > 100) {
    throw new Error("Percent must be between 1 and 100.");
  }

  const [risk, fee] = await Promise.all([
    getUserRiskSettings(req.telegramUserId),
    getEffectiveFeeBps(req.telegramUserId),
  ]);
  const keypair = await loadSigningKeypair(req.telegramUserId);

  const balanceRaw = await getTokenBalanceRaw(keypair.publicKey.toBase58(), req.tokenMint);
  if (balanceRaw <= 0) {
    throw new Error("You don't hold any of that token in your trading wallet.");
  }

  const tokenAmountRaw = computeSellAmountRaw(balanceRaw, req.percent);
  if (tokenAmountRaw <= 0) {
    throw new Error("That percentage rounds down to zero tokens — try a higher percentage.");
  }

  const result = await sellToken({
    keypair,
    tokenMint: req.tokenMint,
    tokenAmountRaw,
    maxPriceImpactPct: risk.maxPriceImpactPct,
    feeBps: fee.feeBps,
  });

  const decimals = await getMintDecimals(req.tokenMint).catch(() => 9);

  await recordTrade({
    telegramUserId: req.telegramUserId,
    tokenMint: req.tokenMint,
    side: "sell",
    solAmount: Number(result.outAmount) / 1_000_000_000,
    txSignature: result.signature,
    tokenAmountRaw,
    tokenDecimals: decimals,
  });

  return { ...result, soldTokenAmount: tokenAmountRaw / 10 ** decimals };
}

/**
 * Adds a token to a user's snipe watchlist so that when it's detected as
 * newly launched/liquid (via the Helius webhook -> handleNewPoolEvent), we
 * auto-buy on their behalf up to their configured amount.
 */
export async function addWatch(telegramUserId: string, tokenMint: string, solAmount: number) {
  if (!isValidMint(tokenMint)) {
    throw new Error("That doesn't look like a valid Solana token address.");
  }
  const { error } = await supabase.from("snipe_watchlist").insert({
    telegram_user_id: telegramUserId,
    token_mint: tokenMint,
    sol_amount: solAmount,
    status: "pending",
  });
  if (error) throw error;
}

/**
 * Called by routes/webhook.ts whenever Helius reports a new liquidity pool /
 * token mint event. Fans out to every user watching that mint.
 */
export async function handleNewPoolEvent(tokenMint: string) {
  const { data: watchers, error } = await supabase
    .from("snipe_watchlist")
    .select("telegram_user_id, sol_amount, id")
    .eq("token_mint", tokenMint)
    .eq("status", "pending");

  if (error) {
    captureException(error, { context: "watchlist_fetch" });
    return;
  }
  if (!watchers || watchers.length === 0) return;

  logger.info({ tokenMint, count: watchers.length }, "Executing snipes for watchers");

  for (const w of watchers) {
    try {
      const [risk, fee] = await Promise.all([
        getUserRiskSettings(w.telegram_user_id),
        getEffectiveFeeBps(w.telegram_user_id),
      ]);
      const keypair = await loadSigningKeypair(w.telegram_user_id);
      const result = await buyToken({
        keypair,
        tokenMint,
        solAmount: w.sol_amount,
        slippageBps: risk.slippageBps,
        maxPriceImpactPct: risk.maxPriceImpactPct,
        feeBps: fee.feeBps,
      });

      await recordTrade({
        telegramUserId: w.telegram_user_id,
        tokenMint,
        side: "buy",
        solAmount: w.sol_amount,
        txSignature: result.signature,
        tokenAmountRaw: Number(result.outAmount),
        tokenDecimals: result.outputDecimals,
      });

      await supabase
        .from("snipe_watchlist")
        .update({ status: "executed", executed_at: new Date().toISOString() })
        .eq("id", w.id);
    } catch (err) {
      captureException(err, {
        context: "auto_snipe",
        telegramUserId: w.telegram_user_id,
        tokenMint,
      });
      await supabase
        .from("snipe_watchlist")
        .update({ status: "failed" })
        .eq("id", w.id);
    }
  }
}
