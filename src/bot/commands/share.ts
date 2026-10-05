import { Context } from "telegraf";
import { getTradeSummary } from "../../services/tradeService";
import { getPortfolioPnl } from "../../services/pnlService";
import { renderShareCard } from "../../services/shareCardService";

export async function shareCommand(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);
  const botUsername = (ctx.botInfo as any)?.username ?? "NexusSolBot";

  const [summary, pnl] = await Promise.all([
    getTradeSummary(telegramUserId),
    getPortfolioPnl(telegramUserId),
  ]);

  if (summary.totalTrades === 0) {
    return ctx.reply("No trades yet — make one with /snipe, then /share your recap.");
  }

  const png = renderShareCard({
    handle: ctx.from?.username ?? null,
    summary,
    realizedPnlSol: pnl.totalRealizedPnlSol,
    botUsername,
  });

  await ctx.replyWithPhoto(
    { source: png },
    { caption: `Realized PNL: ${pnl.totalRealizedPnlSol >= 0 ? "+" : ""}${pnl.totalRealizedPnlSol.toFixed(3)} SOL across ${summary.totalTrades} trades. Traded on @${botUsername}.` }
  );
}
