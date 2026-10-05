import { Context } from "telegraf";
import { getWeeklyLeaderboard } from "../../services/leaderboardService";
import { config } from "../../config";

export async function leaderboardCommand(ctx: Context) {
  const entries = await getWeeklyLeaderboard(10);

  if (entries.length === 0) {
    return ctx.reply("No trades recorded yet this week — be the first on the board.");
  }

  const lines = entries.map((e, i) => {
    const name = e.handle ? `@${e.handle}` : `User ${e.telegramUserId.slice(-4)}`;
    return `${i + 1}. ${name} — ${e.solVolume.toFixed(2)} SOL (${e.tradeCount} trades)`;
  });

  await ctx.reply(
    [
      "*This Week's Top Snipers*",
      ...lines,
      "",
      `Weekly prize pool: ${config.referral.weeklyPrizeSol} SOL to #1, paid out manually every Monday.`,
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}
