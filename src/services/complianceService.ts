import { supabase } from "../db/supabase";

/**
 * IMPORTANT — this is NOT legal advice.
 *
 * This service only enforces a basic UX pattern: a user cannot trade until
 * they've explicitly acknowledged a risk disclosure you control the text
 * of (see backend/LEGAL.md for a starting template). Whether that's
 * *sufficient* for your jurisdiction, and whether operating this bot at all
 * requires money-transmission licensing, KYC/AML, or securities registration
 * where you and your users are located, are questions for an actual lawyer
 * who knows your specific setup — not something this code can determine.
 * Do not treat "the bot has a terms gate" as "the bot is compliant."
 */

export async function hasAcceptedTerms(telegramUserId: string): Promise<boolean> {
  const { data } = await supabase
    .from("users")
    .select("terms_accepted_at")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  return Boolean(data?.terms_accepted_at);
}

export async function acceptTerms(telegramUserId: string): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({ terms_accepted_at: new Date().toISOString() })
    .eq("telegram_user_id", telegramUserId);
  if (error) throw error;
}

export async function requireAcceptedTerms(
  telegramUserId: string
): Promise<{ accepted: true } | { accepted: false; message: string }> {
  const accepted = await hasAcceptedTerms(telegramUserId);
  if (accepted) return { accepted: true };

  return {
    accepted: false,
    message: [
      "Before your first trade, please review the risk disclosure and terms:",
      "",
      "*This bot trades real funds autonomously on your instructions. Token prices on new/low-liquidity listings are extremely volatile, sniping carries a high risk of partial or total loss, and past performance shown on the leaderboard or /share is not indicative of future results.*",
      "",
      "Type /accept to confirm you understand and want to proceed.",
    ].join("\n"),
  };
}
