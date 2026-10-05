import { supabase } from "../db/supabase";
import { assessTokenRisk, riskLevelRank, RiskLevel } from "./riskAnalysisService";
import { loadSigningKeypair } from "./walletService";
import { buyToken, getQuote, SOL_MINT } from "./jupiterService";
import { recordTrade } from "./tradeService";
import { openPosition } from "./positionMonitorService";
import { getEffectiveFeeBps } from "./feeTierService";
import { captureException } from "./monitoringService";
import { logger } from "../utils/logger";

export interface AutopilotSettings {
  enabled: boolean;
  maxBuySol: number;
  budgetSol: number;
  spentSol: number;
  minLiquiditySol: number;
  maxRiskLevel: RiskLevel;
  takeProfitPct: number;
  stopLossPct: number;
  autopilotTermsAcceptedAt: string | null;
}

const DEFAULTS: Omit<AutopilotSettings, "autopilotTermsAcceptedAt"> = {
  enabled: false,
  maxBuySol: 0.05,
  budgetSol: 0.5,
  spentSol: 0,
  minLiquiditySol: 1,
  maxRiskLevel: "medium",
  takeProfitPct: 50,
  stopLossPct: 20,
};

export async function getAutopilotSettings(telegramUserId: string): Promise<AutopilotSettings> {
  const { data } = await supabase
    .from("autopilot_settings")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (!data) return { ...DEFAULTS, autopilotTermsAcceptedAt: null };

  return {
    enabled: data.enabled,
    maxBuySol: Number(data.max_buy_sol),
    budgetSol: Number(data.budget_sol),
    spentSol: Number(data.spent_sol),
    minLiquiditySol: Number(data.min_liquidity_sol),
    maxRiskLevel: data.max_risk_level,
    takeProfitPct: Number(data.take_profit_pct),
    stopLossPct: Number(data.stop_loss_pct),
    autopilotTermsAcceptedAt: data.autopilot_terms_accepted_at,
  };
}

export async function updateAutopilotSettings(
  telegramUserId: string,
  patch: Partial<{
    enabled: boolean;
    maxBuySol: number;
    budgetSol: number;
    minLiquiditySol: number;
    maxRiskLevel: RiskLevel;
    takeProfitPct: number;
    stopLossPct: number;
  }>
): Promise<void> {
  const row: Record<string, unknown> = { telegram_user_id: telegramUserId };
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.maxBuySol !== undefined) row.max_buy_sol = patch.maxBuySol;
  if (patch.budgetSol !== undefined) row.budget_sol = patch.budgetSol;
  if (patch.minLiquiditySol !== undefined) row.min_liquidity_sol = patch.minLiquiditySol;
  if (patch.maxRiskLevel !== undefined) row.max_risk_level = patch.maxRiskLevel;
  if (patch.takeProfitPct !== undefined) row.take_profit_pct = patch.takeProfitPct;
  if (patch.stopLossPct !== undefined) row.stop_loss_pct = patch.stopLossPct;
  row.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from("autopilot_settings")
    .upsert(row, { onConflict: "telegram_user_id" });
  if (error) throw error;
}

export async function acceptAutopilotTerms(telegramUserId: string): Promise<void> {
  const { error } = await supabase
    .from("autopilot_settings")
    .upsert(
      { telegram_user_id: telegramUserId, autopilot_terms_accepted_at: new Date().toISOString() },
      { onConflict: "telegram_user_id" }
    );
  if (error) throw error;
}

/**
 * Rough liquidity estimate in SOL terms, inferred from price impact rather
 * than reading pool reserves directly (which vary by DEX program and
 * aren't uniformly readable). Intentionally approximate — a floor filter,
 * not a precise TVL figure.
 */
async function estimateLiquiditySol(tokenMint: string): Promise<number | null> {
  try {
    const probeLamports = 1_000_000_000; // 1 SOL
    const quote = await getQuote(SOL_MINT, tokenMint, probeLamports);
    const impactPct = Number(quote.priceImpactPct) * 100;
    if (impactPct <= 0) return null;
    return 100 / impactPct;
  } catch {
    return null;
  }
}

/**
 * Called for every user with autopilot enabled whenever a new token is
 * detected (via the Helius webhook). Runs the risk/liquidity gate; only
 * buys if the token clears the user's configured thresholds AND the
 * user's budget isn't exhausted.
 */
export async function runAutopilotForToken(telegramUserId: string, tokenMint: string): Promise<void> {
  const settings = await getAutopilotSettings(telegramUserId);

  if (!settings.enabled || !settings.autopilotTermsAcceptedAt) return;
  if (settings.spentSol + settings.maxBuySol > settings.budgetSol) {
    logger.info({ telegramUserId }, "Autopilot budget exhausted — auto-disabling");
    await updateAutopilotSettings(telegramUserId, { enabled: false });
    return;
  }

  const [risk, liquiditySol] = await Promise.all([
    assessTokenRisk(tokenMint),
    estimateLiquiditySol(tokenMint),
  ]);

  if (riskLevelRank(risk.level) > riskLevelRank(settings.maxRiskLevel)) {
    logger.info({ telegramUserId, tokenMint, risk: risk.level }, "Autopilot skipped: risk too high");
    return;
  }
  if (liquiditySol != null && liquiditySol < settings.minLiquiditySol) {
    logger.info({ telegramUserId, tokenMint, liquiditySol }, "Autopilot skipped: liquidity too thin");
    return;
  }

  try {
    const keypair = await loadSigningKeypair(telegramUserId);
    const fee = await getEffectiveFeeBps(telegramUserId);

    const result = await buyToken({
      keypair,
      tokenMint,
      solAmount: settings.maxBuySol,
      feeBps: fee.feeBps,
      // Autopilot is conservative by default — reject material price
      // impact rather than using the looser manual-trade default.
      maxPriceImpactPct: 8,
    });

    await recordTrade({
      telegramUserId,
      tokenMint,
      side: "buy",
      solAmount: settings.maxBuySol,
      txSignature: result.signature,
      tokenAmountRaw: Number(result.outAmount),
      tokenDecimals: result.outputDecimals,
    });

    await openPosition({
      telegramUserId,
      tokenMint,
      entrySolAmount: settings.maxBuySol,
      entryTokenAmountRaw: Number(result.outAmount),
      tokenDecimals: result.outputDecimals,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct: settings.stopLossPct,
      openedVia: "autopilot",
    });

    await supabase
      .from("autopilot_settings")
      .update({ spent_sol: settings.spentSol + settings.maxBuySol, updated_at: new Date().toISOString() })
      .eq("telegram_user_id", telegramUserId);

    logger.info({ telegramUserId, tokenMint, risk: risk.level }, "Autopilot executed a buy");
  } catch (err) {
    captureException(err, { context: "autopilot_buy", telegramUserId, tokenMint });
  }
}

export async function runAutopilotForAllUsers(tokenMint: string): Promise<void> {
  const { data: enabledUsers, error } = await supabase
    .from("autopilot_settings")
    .select("telegram_user_id")
    .eq("enabled", true);

  if (error) {
    captureException(error, { context: "autopilot_fetch_users" });
    return;
  }
  if (!enabledUsers || enabledUsers.length === 0) return;

  for (const u of enabledUsers) {
    await runAutopilotForToken(u.telegram_user_id, tokenMint);
  }
}
