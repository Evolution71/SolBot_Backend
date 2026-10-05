import { supabase } from "../db/supabase";
import { assessTokenRisk } from "./riskAnalysisService";
import { captureException } from "./monitoringService";

export interface FeedEntry {
  tokenMint: string;
  riskLevel: string;
  riskScore: number;
  liquidityEstimateSol: number | null;
  autopilotBuys: number;
  detectedAt: string;
}

/**
 * Runs the risk scanner on a newly detected token and logs the result,
 * independent of whether any user's Autopilot or /watch acted on it. This
 * is what powers the public Live Feed — every row is a real detection with
 * a real risk assessment, not a placeholder.
 */
export async function recordDetection(tokenMint: string, autopilotBuys = 0): Promise<void> {
  try {
    const risk = await assessTokenRisk(tokenMint);
    const liquidityFactor = risk.factors.priceImpactAt1SolPct;
    const liquidityEstimateSol = liquidityFactor && liquidityFactor > 0 ? 100 / liquidityFactor : null;

    const { error } = await supabase.from("detected_tokens").insert({
      token_mint: tokenMint,
      risk_level: risk.level,
      risk_score: risk.score,
      liquidity_estimate_sol: liquidityEstimateSol,
      autopilot_buys: autopilotBuys,
    });
    if (error) throw error;
  } catch (err) {
    captureException(err, { context: "record_detection", tokenMint });
  }
}

export async function getRecentFeed(limit = 30): Promise<FeedEntry[]> {
  const { data, error } = await supabase
    .from("detected_tokens")
    .select("*")
    .order("detected_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    tokenMint: row.token_mint,
    riskLevel: row.risk_level,
    riskScore: row.risk_score,
    liquidityEstimateSol: row.liquidity_estimate_sol,
    autopilotBuys: row.autopilot_buys,
    detectedAt: row.detected_at,
  }));
}
