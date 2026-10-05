import { supabase } from "../db/supabase";

function generateCode(telegramUserId: string): string {
  // Short, human-shareable code derived from the user id + randomness.
  const rand = Math.random().toString(36).slice(2, 6);
  return `NX${telegramUserId.slice(-4)}${rand}`.toUpperCase();
}

export async function getOrCreateReferralCode(telegramUserId: string): Promise<string> {
  const { data: existing, error } = await supabase
    .from("users")
    .select("referral_code")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (error) throw error;
  if (existing?.referral_code) return existing.referral_code;

  const code = generateCode(telegramUserId);
  const { error: upsertErr } = await supabase
    .from("users")
    .upsert({ telegram_user_id: telegramUserId, referral_code: code }, { onConflict: "telegram_user_id" });
  if (upsertErr) throw upsertErr;

  return code;
}

/**
 * Called when a NEW user starts the bot with a referral code (/start CODE).
 * Real, verifiable referrals only — no fabricated counts.
 */
export async function applyReferral(newUserTelegramId: string, referralCode: string) {
  const { data: referrer, error } = await supabase
    .from("users")
    .select("telegram_user_id")
    .eq("referral_code", referralCode)
    .maybeSingle();

  if (error) throw error;
  if (!referrer) return null; // invalid/unknown code — silently ignore
  if (referrer.telegram_user_id === newUserTelegramId) return null; // no self-referral

  const { error: insertErr } = await supabase.from("referrals").insert({
    referrer_telegram_user_id: referrer.telegram_user_id,
    referred_telegram_user_id: newUserTelegramId,
  });
  // Unique constraint prevents double-counting the same referred user.
  if (insertErr && insertErr.code !== "23505") throw insertErr;

  return referrer.telegram_user_id;
}

export async function getReferralStats(telegramUserId: string) {
  const [{ count: totalReferrals }, code] = await Promise.all([
    supabase
      .from("referrals")
      .select("*", { count: "exact", head: true })
      .eq("referrer_telegram_user_id", telegramUserId),
    getOrCreateReferralCode(telegramUserId),
  ]);

  return {
    referralCode: code,
    totalReferrals: totalReferrals ?? 0,
  };
}
