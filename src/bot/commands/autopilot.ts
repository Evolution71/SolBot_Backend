import { Context } from "telegraf";
import {
  getAutopilotSettings,
  updateAutopilotSettings,
  acceptAutopilotTerms,
} from "../../services/autopilotService";
import { RiskLevel } from "../../services/riskAnalysisService";

function parseArgs(ctx: Context): string[] {
  const text = "text" in (ctx.message ?? {}) ? (ctx.message as any).text : "";
  return text.trim().split(/\s+/).slice(1);
}

const DISCLOSURE = [
  "*Autopilot Risk Disclosure*",
  "",
  "Autopilot buys tokens automatically, with no per-trade confirmation from you, whenever a newly-detected token clears your configured risk and liquidity filters. It will also auto-sell using your configured take-profit/stop-loss.",
  "",
  "The risk/liquidity filter catches common rug patterns (unrenounced mint/freeze authority, extreme holder concentration, very thin liquidity) — it does *not* guarantee a token is safe, legitimate, or will go up in value. New tokens are highly volatile and Autopilot can lose your entire configured budget, including on tokens that pass every check.",
  "",
  "Type `/autopilot accept` to confirm you understand this before turning it on.",
].join("\n");

export async function autopilotCommand(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);
  const [sub, ...rest] = parseArgs(ctx);

  if (sub === "accept") {
    await acceptAutopilotTerms(telegramUserId);
    return ctx.reply("Understood — you can now run `/autopilot on` to enable it.", { parse_mode: "Markdown" });
  }

  if (sub === "on") {
    const settings = await getAutopilotSettings(telegramUserId);
    if (!settings.autopilotTermsAcceptedAt) {
      return ctx.reply(DISCLOSURE, { parse_mode: "Markdown" });
    }
    await updateAutopilotSettings(telegramUserId, { enabled: true });
    return ctx.reply(
      `\u{1F7E2} Autopilot is ON. Buying up to ${settings.maxBuySol} SOL per token, budget ${settings.budgetSol} SOL total, max risk ${settings.maxRiskLevel}, TP +${settings.takeProfitPct}% / SL -${settings.stopLossPct}%.\nAdjust anytime with \`/autopilot config\`.`,
      { parse_mode: "Markdown" }
    );
  }

  if (sub === "off") {
    await updateAutopilotSettings(telegramUserId, { enabled: false });
    return ctx.reply("\u{1F534} Autopilot is OFF. No further automatic buys will happen.");
  }

  if (sub === "config") {
    const [key, value] = rest;
    const num = Number(value);

    if (key === "budget" && Number.isFinite(num) && num > 0) {
      await updateAutopilotSettings(telegramUserId, { budgetSol: num });
      return ctx.reply(`Total autopilot budget set to ${num} SOL.`);
    }
    if (key === "maxbuy" && Number.isFinite(num) && num > 0) {
      await updateAutopilotSettings(telegramUserId, { maxBuySol: num });
      return ctx.reply(`Per-token buy amount set to ${num} SOL.`);
    }
    if (key === "minliq" && Number.isFinite(num) && num >= 0) {
      await updateAutopilotSettings(telegramUserId, { minLiquiditySol: num });
      return ctx.reply(`Minimum liquidity filter set to ~${num} SOL.`);
    }
    if (key === "risk" && ["low", "medium", "high"].includes(value)) {
      await updateAutopilotSettings(telegramUserId, { maxRiskLevel: value as RiskLevel });
      return ctx.reply(`Max acceptable risk level set to ${value}.`);
    }
    if (key === "tp" && Number.isFinite(num) && num > 0) {
      await updateAutopilotSettings(telegramUserId, { takeProfitPct: num });
      return ctx.reply(`Take-profit set to +${num}%.`);
    }
    if (key === "sl" && Number.isFinite(num) && num > 0 && num < 100) {
      await updateAutopilotSettings(telegramUserId, { stopLossPct: num });
      return ctx.reply(`Stop-loss set to -${num}%.`);
    }

    return ctx.reply(
      [
        "Usage: `/autopilot config <key> <value>`",
        "Keys: `budget` `maxbuy` `minliq` `risk` `tp` `sl`",
        "Example: `/autopilot config maxbuy 0.1`",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  }

  // Default: show status
  const settings = await getAutopilotSettings(telegramUserId);
  await ctx.reply(
    [
      `*Autopilot: ${settings.enabled ? "\u{1F7E2} ON" : "\u{1F534} OFF"}*`,
      `Per-token buy: ${settings.maxBuySol} SOL`,
      `Total budget: ${settings.spentSol.toFixed(4)} / ${settings.budgetSol} SOL spent`,
      `Min liquidity filter: ~${settings.minLiquiditySol} SOL`,
      `Max risk accepted: ${settings.maxRiskLevel}`,
      `Take-profit / Stop-loss: +${settings.takeProfitPct}% / -${settings.stopLossPct}%`,
      "",
      "`/autopilot on` / `/autopilot off`",
      "`/autopilot config <budget|maxbuy|minliq|risk|tp|sl> <value>`",
      "`/positions` — see open TP/SL-tracked positions",
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}
