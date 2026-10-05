import { Telegraf } from "telegraf";
import { config } from "../config";
import { startCommand } from "./commands/start";
import { walletCommand, exportCommand } from "./commands/wallet";
import { snipeCommand, sellCommand, watchCommand, checkCommand } from "./commands/snipe";
import { confirmTradeAction, cancelTradeAction } from "./commands/tradeActions";
import { settingsCommand } from "./commands/settings";
import { referralCommand } from "./commands/referral";
import { leaderboardCommand } from "./commands/leaderboard";
import { shareCommand } from "./commands/share";
import { acceptCommand } from "./commands/accept";
import { menuCommand, menuAction } from "./commands/menu";
import { autopilotCommand } from "./commands/autopilot";
import { positionsCommand } from "./commands/positions";
import { captureException } from "../services/monitoringService";

export const bot = new Telegraf(config.telegram.botToken);

bot.start(startCommand);
bot.command("wallet", walletCommand);
bot.command("export", exportCommand);
bot.command("snipe", snipeCommand);
bot.command("sell", sellCommand);
bot.command("watch", watchCommand);
bot.command("check", checkCommand);
bot.command("settings", settingsCommand);
bot.command("referral", referralCommand);
bot.command("leaderboard", leaderboardCommand);
bot.command("share", shareCommand);
bot.command("accept", acceptCommand);
bot.command("menu", menuCommand);
bot.command("autopilot", autopilotCommand);
bot.command("positions", positionsCommand);

bot.action(/^confirm_trade:/, confirmTradeAction);
bot.action(/^cancel_trade:/, cancelTradeAction);
bot.action(/^menu:/, menuAction);

bot.help((ctx) =>
  ctx.reply(
    [
      "/menu — tap-friendly menu (no typing required)",
      "/wallet — balance & deposit address",
      "/accept — accept the risk disclosure (required once, before trading)",
      "/check <token> — analyze a token for rug/liquidity red flags",
      "/snipe <token> <sol> [tp%] [sl%] — buy now, with optional auto take-profit/stop-loss",
      "/sell <token> <percent> — sell a percentage of your holding",
      "/watch <token> <sol> — auto-buy one specific token when it goes live",
      "/autopilot — fully automated hands-off sniping across ALL new launches (risk-gated)",
      "/positions — see open take-profit/stop-loss-tracked positions",
      "/settings — slippage, fees, and max price-impact limit",
      "/referral — invite link & stats (lower fees for real invites)",
      "/leaderboard — this week's top traders",
      "/share — trade recap card (real numbers, generated as an image)",
      "/export — export your private key",
    ].join("\n")
  )
);

bot.catch((err, ctx) => {
  captureException(err, { context: "telegram_bot", updateType: ctx.updateType });
  ctx.reply("Something went wrong on my end — try again in a moment.").catch(() => {});
});
