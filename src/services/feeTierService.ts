import { supabase } from "../db/supabase";
import { config } from "../config";

/**
 * Real, verifiable fee incentives — every discount here is computed from
 * actual rows in `trades`/`referrals`, never a fabricated promo counter.
 *
 * - New users pay 0% fee on their first few trades (a genuine "try it free"
 *   hook, not a marketing claim — it's enforced in code).
 * - Users who bring in real referrals get a standing discount, which also
 *   rewards the existing /referral loop instead of it being cosmetic.
 */
const WELCOME_FREE_TRADES = 3;

const REFERRAL_DISCOUNT_TIERS: Array<{ minReferrals: number; feeBps: number }> = [
  { minReferrals: 10, feeBps: 50 }, // 0.5% — 50% off
  { minReferrals: 3, feeBps: 75 }, // 0.75% — 25% off
];

/**
 * Pure function, unit-testable without touching Supabase: given a user's
 * real trade count and real referral count, returns the fee (in bps) that
 * should apply to their *next* trade.
 */
export function computeEffectiveFeeBps(params: {
  priorTradeCount: number;
  referralCount: number;
  baseFeeBps?: number;
}): { feeBps: number; reason: string } {
  const baseFeeBps = params.baseFeeBps ?? config.solana.platformFeeBps;

  if (params.priorTradeCount < WELCOME_FREE_TRADES) {
    return {
      feeBps: 0,
      reason: `Welcome offer: your first ${WELCOME_FREE_TRADES} trades are fee-free (${params.priorTradeCount + 1}/${WELCOME_FREE_TRADES}).`,
    };
  }

  for (const tier of REFERRAL_DISCOUNT_TIERS) {
    if (params.referralCount >= tier.minReferrals) {
      return {
        feeBps: tier.feeBps,
        reason: `Referral discount: ${(tier.feeBps / 100).toFixed(2)}% fee for ${tier.minReferrals}+ referrals.`,
      };
    }
  }

  return { feeBps: baseFeeBps, reason: `Standard ${(baseFeeBps / 100).toFixed(2)}% fee.` };
}

export async function getEffectiveFeeBps(
  telegramUserId: string
): Promise<{ feeBps: number; reason: string }> {
  const [{ count: priorTradeCount }, { count: referralCount }] = await Promise.all([
    supabase
      .from("trades")
      .select("*", { count: "exact", head: true })
      .eq("telegram_user_id", telegramUserId),
    supabase
      .from("referrals")
      .select("*", { count: "exact", head: true })
      .eq("referrer_telegram_user_id", telegramUserId),
  ]);

  return computeEffectiveFeeBps({
    priorTradeCount: priorTradeCount ?? 0,
    referralCount: referralCount ?? 0,
  });
}
