import { Context } from "telegraf";
import { supabase } from "../../db/supabase";
import { config } from "../../config";
import { getEffectiveFeeBps } from "../../services/feeTierService";

export async function settingsCommand(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);
  const args = "text" in (ctx.message ?? {}) ? (ctx.message as any).text.trim().split(/\s+/).slice(1) : [];

  if (args[0] === "slippage" && args[1]) {
    const bps = Number(args[1]);
    if (!Number.isFinite(bps) || bps < 0 || bps > 5000) {
      return ctx.reply("Slippage must be a number of basis points between 0 and 5000 (e.g. 300 = 3%).");
    }
    await supabase
      .from("users")
      .upsert({ telegram_user_id: telegramUserId, slippage_bps: bps }, { onConflict: "telegram_user_id" });
    return ctx.reply(`Slippage set to ${(bps / 100).toFixed(2)}%.`);
  }

  if (args[0] === "impact" && args[1]) {
    const pct = Number(args[1]);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return ctx.reply("Max price impact must be a percentage between 0 and 100 (e.g. 5 = reject trades with >5% impact).");
    }
    await supabase
      .from("users")
      .upsert(
        { telegram_user_id: telegramUserId, max_price_impact_pct: pct },
        { onConflict: "telegram_user_id" }
      );
    return ctx.reply(`Max price impact set to ${pct}%. Trades quoting worse than this will be rejected before signing.`);
  }

  const [{ data }, fee] = await Promise.all([
    supabase
      .from("users")
      .select("slippage_bps, max_price_impact_pct")
      .eq("telegram_user_id", telegramUserId)
      .maybeSingle(),
    getEffectiveFeeBps(telegramUserId),
  ]);

  const slippage = data?.slippage_bps ?? config.solana.defaultSlippageBps;
  const impact = data?.max_price_impact_pct ?? config.mev.maxPriceImpactPctDefault;

  await ctx.reply(
    [
      "*Settings*",
      `Slippage: ${(slippage / 100).toFixed(2)}%`,
      `Max price impact: ${impact}% (trades above this are auto-rejected)`,
      `Your current fee: ${fee.feeBps === 0 ? "FREE" : `${(fee.feeBps / 100).toFixed(2)}%`}`,
      `  ↳ ${fee.reason}`,
      "",
      "Change slippage: `/settings slippage 300` (300 bps = 3%)",
      "Change impact limit: `/settings impact 5` (5 = reject trades over 5% impact)",
      "",
      "Want a lower fee permanently? Invite friends with /referral — 3+ referrals gets 0.75%, 10+ gets 0.5%.",
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}
