import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { config } from "../config";
import { getQuote, SOL_MINT } from "./jupiterService";
import { logger } from "../utils/logger";

/**
 * HONEST SCOPE OF THIS MODULE
 * ---------------------------------------------------------------------------
 * This is a heuristic red-flag screen, not a guarantee. It checks the
 * on-chain signals that cover the most common rug-pull and thin-liquidity
 * patterns on Solana:
 *
 * - Mint authority not renounced -> the deployer can mint unlimited new
 *   supply at any time, instantly diluting/crashing the price.
 * - Freeze authority not renounced -> the deployer can freeze any holder's
 *   token account, including making it unsellable.
 * - Extreme holder concentration -> a handful of wallets (often the
 *   deployer's own) hold enough supply to crash the price on exit.
 * - Thin liquidity -> a modest buy already moves the price sharply,
 *   meaning a sale of any size will move it sharply too.
 *
 * What this CANNOT detect: malicious upgradeable program logic, hidden
 * transfer-tax mechanisms, timed LP unlocks, off-chain rug coordination, or
 * a deployer who behaves fine for hours/days before pulling liquidity. A
 * "low risk" label reduces exposure to the most common scam patterns — it
 * is not a prediction that a token will go up, or a promise that it's
 * safe. Treat it as a filter, not a signal to buy.
 * ---------------------------------------------------------------------------
 */

const connection = new Connection(config.solana.rpcUrl, "confirmed");

export type RiskLevel = "low" | "medium" | "high";

export interface RiskFactors {
  mintAuthorityRenounced: boolean | null; // null = couldn't determine
  freezeAuthorityRenounced: boolean | null;
  topHolderConcentrationPct: number | null; // % of supply held by top 10 non-LP-looking accounts
  priceImpactAt1SolPct: number | null; // higher = thinner liquidity
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number; // 0 (safest signals) to 100 (worst signals seen)
  reasons: string[];
  factors: RiskFactors;
}

/**
 * Pure scoring function, unit-testable without any RPC/network calls.
 * Takes the raw factors and turns them into a level + human-readable
 * reasons. Kept separate from the data-fetching so the decision logic can
 * be tested deterministically.
 */
export function scoreRiskFactors(factors: RiskFactors): RiskAssessment {
  let score = 0;
  const reasons: string[] = [];

  if (factors.mintAuthorityRenounced === false) {
    score += 35;
    reasons.push("Mint authority is still active — supply can be inflated at will.");
  } else if (factors.mintAuthorityRenounced === null) {
    score += 10;
    reasons.push("Couldn't verify mint authority status.");
  }

  if (factors.freezeAuthorityRenounced === false) {
    score += 25;
    reasons.push("Freeze authority is still active — holder accounts can be frozen.");
  } else if (factors.freezeAuthorityRenounced === null) {
    score += 5;
    reasons.push("Couldn't verify freeze authority status.");
  }

  if (factors.topHolderConcentrationPct != null) {
    if (factors.topHolderConcentrationPct > 80) {
      score += 30;
      reasons.push(`Top holders control ${factors.topHolderConcentrationPct.toFixed(0)}% of supply.`);
    } else if (factors.topHolderConcentrationPct > 50) {
      score += 15;
      reasons.push(`Top holders control ${factors.topHolderConcentrationPct.toFixed(0)}% of supply.`);
    }
  }

  if (factors.priceImpactAt1SolPct != null) {
    if (factors.priceImpactAt1SolPct > 15) {
      score += 25;
      reasons.push(`A 1 SOL buy moves the price ~${factors.priceImpactAt1SolPct.toFixed(1)}% — very thin liquidity.`);
    } else if (factors.priceImpactAt1SolPct > 5) {
      score += 10;
      reasons.push(`A 1 SOL buy moves the price ~${factors.priceImpactAt1SolPct.toFixed(1)}% — thin liquidity.`);
    }
  }

  score = Math.min(100, score);

  let level: RiskLevel = "low";
  if (score >= 50) level = "high";
  else if (score >= 20) level = "medium";

  if (reasons.length === 0) reasons.push("No major red flags detected in the checks this bot runs.");

  return { level, score, reasons, factors };
}

/** Ordering used to compare a token's risk against a user's configured ceiling. */
export function riskLevelRank(level: RiskLevel): number {
  return { low: 0, medium: 1, high: 2 }[level];
}

async function getMintAuthorityFactors(mint: string): Promise<{
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
}> {
  try {
    const info = await getMint(connection, new PublicKey(mint));
    return {
      mintAuthorityRenounced: info.mintAuthority === null,
      freezeAuthorityRenounced: info.freezeAuthority === null,
    };
  } catch (err) {
    logger.warn({ err, mint }, "Failed to read mint account for risk analysis");
    return { mintAuthorityRenounced: null, freezeAuthorityRenounced: null };
  }
}

async function getTopHolderConcentration(mint: string): Promise<number | null> {
  try {
    const mintPubkey = new PublicKey(mint);
    const [largest, supply] = await Promise.all([
      connection.getTokenLargestAccounts(mintPubkey),
      connection.getTokenSupply(mintPubkey),
    ]);

    const totalSupply = Number(supply.value.amount);
    if (totalSupply <= 0) return null;

    const top10 = largest.value.slice(0, 10).reduce((sum, acc) => sum + Number(acc.amount), 0);
    return (top10 / totalSupply) * 100;
  } catch (err) {
    logger.warn({ err, mint }, "Failed to compute holder concentration");
    return null;
  }
}

async function getLiquidityDepthSignal(mint: string): Promise<number | null> {
  try {
    const oneSolLamports = 1_000_000_000;
    const quote = await getQuote(SOL_MINT, mint, oneSolLamports);
    return Number(quote.priceImpactPct) * 100;
  } catch (err) {
    logger.warn({ err, mint }, "Failed to get liquidity depth quote for risk analysis");
    return null;
  }
}

export async function assessTokenRisk(mint: string): Promise<RiskAssessment> {
  const [authorities, concentration, liquidity] = await Promise.all([
    getMintAuthorityFactors(mint),
    getTopHolderConcentration(mint),
    getLiquidityDepthSignal(mint),
  ]);

  return scoreRiskFactors({
    mintAuthorityRenounced: authorities.mintAuthorityRenounced,
    freezeAuthorityRenounced: authorities.freezeAuthorityRenounced,
    topHolderConcentrationPct: concentration,
    priceImpactAt1SolPct: liquidity,
  });
}
