import { Context } from "telegraf";
import { supabase } from "../../db/supabase";
import { getOrCreateWallet } from "../../services/walletService";
import { applyReferral, getOrCreateReferralCode } from "../../services/referralService";
import { logger } from "../../utils/logger";

export async function startCommand(ctx: Context) {
  const from = ctx.from;
  if (!from) return;

  const telegramUserId = String(from.id);
  const payload =
    "text" in (ctx.message ?? {}) ? (ctx.message as any).text?.split(" ")[1] : undefined;

  // Upsert user record
  await supabase.from("users").upsert(
    {
      telegram_user_id: telegramUserId,
      telegram_handle: from.username ?? null,
    },
    { onConflict: "telegram_user_id" }
  );

  // Apply referral if a code was passed: /start NX1234AB
  if (payload) {
    try {
      await applyReferral(telegramUserId, payload);
    } catch (err) {
      logger.warn({ err }, "Referral application failed (non-fatal)");
    }
  }

  const wallet = await getOrCreateWallet(telegramUserId);
  const referralCode = await getOrCreateReferralCode(telegramUserId);

  await ctx.reply(
    [
      "*Welcome to NEXUS SOL BOT* \u{1F680}",
      "",
      "I've generated a dedicated Solana trading wallet for you — this is *not* your main wallet, and I will *never* ask you to paste a private key or seed phrase. That's how people get rug-pulled.",
      "",
      `*Your trading wallet:*\n\`${wallet.publicKey}\``,
      "",
      "Send SOL to that address to start trading with it. Export your key anytime with /export — you're never locked in.",
      "",
      "\u{1F381} *Your first 3 trades are fee-free.* After that it's a flat 1% per trade — or less if you refer friends (see /referral).",
      "",
      "Every /snipe and /sell shows you the exact quote, price impact, fee, and a real rug/liquidity risk check *before* anything is signed — you'll always confirm with a button first.",
      "",
      "Want it fully hands-off? /autopilot buys automatically on new launches that pass your risk filters, with auto take-profit/stop-loss.",
      "",
      "*Commands:*",
      "/menu — tap-friendly menu, no typing required",
      "/accept — accept the risk disclosure (do this first)",
      "/wallet — view balance & deposit address",
      "/check <token address> — analyze a token for rug/liquidity red flags",
      "/snipe <token address> <SOL amount> [tp%] [sl%] — buy, with optional auto-exit",
      "/sell <token address> <percent> — sell a percentage of your holding",
      "/watch <token address> <SOL amount> — auto-buy the moment it's tracked as live",
      "/autopilot — fully automated hands-off sniping (risk-gated)",
      "/positions — see open take-profit/stop-loss-tracked positions",
      "/settings — slippage, fees & risk preferences",
      "/referral — your invite link & stats (lower fees for real invites)",
      "/leaderboard — this week's top traders (real volume, not fake)",
      "/share — generate a trade recap card",
      "/export — export your trading wallet's private key",
      "",
      `Your referral code: \`${referralCode}\``,
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}
