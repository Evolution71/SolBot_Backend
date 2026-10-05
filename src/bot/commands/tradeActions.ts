import { Context } from "telegraf";
import { consumePendingTrade, discardPendingTrade } from "../../services/pendingTradeStore";
import { manualSnipe, manualSell } from "../../services/snipeService";

function extractId(ctx: Context): string | null {
  const data = (ctx.callbackQuery as any)?.data as string | undefined;
  if (!data) return null;
  const [, id] = data.split(":");
  return id ?? null;
}

export async function confirmTradeAction(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);
  const id = extractId(ctx);

  await ctx.answerCbQuery(); // clears the loading spinner on the tapped button

  if (!id) return;

  const trade = consumePendingTrade(id, telegramUserId);
  if (!trade) {
    return ctx.editMessageText("This quote has expired — run the command again for a fresh one.");
  }

  await ctx.editMessageText("\u23F1 Executing...");

  try {
    if (trade.kind === "buy") {
      const result = await manualSnipe({
        telegramUserId,
        tokenMint: trade.tokenMint,
        solAmount: trade.solAmount,
        takeProfitPct: trade.takeProfitPct,
        stopLossPct: trade.stopLossPct,
      });
      const tpslLine =
        trade.takeProfitPct || trade.stopLossPct
          ? `Auto-exit armed: ${trade.takeProfitPct ? `TP +${trade.takeProfitPct}%` : "no TP"} / ${trade.stopLossPct ? `SL -${trade.stopLossPct}%` : "no SL"}`
          : null;
      await ctx.editMessageText(
        [
          "\u2705 *Snipe executed*",
          `Spent: ${trade.solAmount} SOL`,
          `Received (raw units): ${result.outAmount}`,
          `Price impact: ${result.priceImpactPct}%`,
          `Fee charged: ${(result.feeLamports / 1_000_000_000).toFixed(4)} SOL`,
          `Tx: \`${result.signature}\``,
          ...(tpslLine ? ["", tpslLine] : []),
        ].join("\n"),
        { parse_mode: "Markdown" }
      );
    } else {
      const result = await manualSell({
        telegramUserId,
        tokenMint: trade.tokenMint,
        percent: trade.percent,
      });
      await ctx.editMessageText(
        [
          "\u2705 *Sell executed*",
          `Sold: ${result.soldTokenAmount} tokens (${trade.percent}%)`,
          `Received: ${(Number(result.outAmount) / 1_000_000_000).toFixed(4)} SOL`,
          `Price impact: ${result.priceImpactPct}%`,
          `Fee charged: ${(result.feeLamports / 1_000_000_000).toFixed(4)} SOL`,
          `Tx: \`${result.signature}\``,
          "",
          "Run /share to see your updated realized PNL.",
        ].join("\n"),
        { parse_mode: "Markdown" }
      );
    }
  } catch (err: any) {
    await ctx.editMessageText(`\u274C Trade failed: ${err.message ?? "unknown error"}`);
  }
}

export async function cancelTradeAction(ctx: Context) {
  const id = extractId(ctx);
  await ctx.answerCbQuery("Cancelled");
  if (id) discardPendingTrade(id);
  await ctx.editMessageText("Cancelled — no funds moved.");
}
