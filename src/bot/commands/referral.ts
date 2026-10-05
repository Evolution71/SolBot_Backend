import { Context } from "telegraf";
import { getReferralStats } from "../../services/referralService";
import { config } from "../../config";

export async function referralCommand(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);
  const botUsername = (ctx.botInfo as any)?.username ?? "NexusSolBot";
  const stats = await getReferralStats(telegramUserId);

  const link = `https://t.me/${botUsername}?start=${stats.referralCode}`;

  await ctx.reply(
    [
      "*Your Referral Stats*",
      `Invites: *${stats.totalReferrals}*`,
      `Your link: ${link}`,
      "",
      config.referral.bonusSol > 0
        ? `Earn ${config.referral.bonusSol} SOL for every friend who trades after joining through your link.`
        : "Share your link — every real referral counts toward the weekly leaderboard.",
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}
