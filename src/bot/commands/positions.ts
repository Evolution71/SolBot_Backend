import { Context } from "telegraf";
import { supabase } from "../../db/supabase";
import { getQuote, SOL_MINT } from "../../services/jupiterService";

export async function positionsCommand(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);

  const { data: positions } = await supabase
    .from("positions")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .eq("status", "open")
    .order("opened_at", { ascending: false });

  if (!positions || positions.length === 0) {
    return ctx.reply("No open monitored positions. Positions with a take-profit or stop-loss attached show up here.");
  }

  const lines: string[] = ["*Open Positions*", ""];

  for (const p of positions) {
    let currentValueLine = "current value unavailable";
    try {
      const quote = await getQuote(p.token_mint, SOL_MINT, p.entry_token_amount_raw);
      const currentValue = Number(quote.outAmount) / 1_000_000_000;
      const pnlPct = ((currentValue - p.entry_sol_amount) / p.entry_sol_amount) * 100;
      const sign = pnlPct >= 0 ? "+" : "";
      currentValueLine = `now worth ~${currentValue.toFixed(4)} SOL (${sign}${pnlPct.toFixed(1)}%)`;
    } catch {
      // leave default message
    }

    lines.push(
      `\`${p.token_mint.slice(0, 8)}...\` — entry ${Number(p.entry_sol_amount).toFixed(4)} SOL, ${currentValueLine}`
    );
    if (p.take_profit_pct || p.stop_loss_pct) {
      lines.push(
        `  ↳ TP ${p.take_profit_pct ? `+${p.take_profit_pct}%` : "none"} / SL ${p.stop_loss_pct ? `-${p.stop_loss_pct}%` : "none"}`
      );
    }
  }

  lines.push("", "_Checked automatically every 20s — closes on its own when a target is hit._");

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
