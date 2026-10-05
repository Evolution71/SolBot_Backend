import { Context, Markup } from "telegraf";
import { walletCommand } from "./wallet";
import { settingsCommand } from "./settings";
import { referralCommand } from "./referral";
import { leaderboardCommand } from "./leaderboard";
import { shareCommand } from "./share";

/**
 * A tappable hub for people who don't want to memorize command syntax.
 * Every button here just re-runs an existing command handler, so there's
 * no duplicated logic to maintain.
 */
export async function menuCommand(ctx: Context) {
  await ctx.reply(
    "*NEXUS SOL BOT*\nWhat do you want to do?",
    {
      parse_mode: "Markdown",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("\u{1F4B0} Wallet", "menu:wallet"), Markup.button.callback("\u{2699} Settings", "menu:settings")],
        [Markup.button.callback("\u{1F517} Referral", "menu:referral"), Markup.button.callback("\u{1F3C6} Leaderboard", "menu:leaderboard")],
        [Markup.button.callback("\u{1F4CA} Share Recap", "menu:share")],
      ]).reply_markup,
    }
  );
}

export async function menuAction(ctx: Context) {
  const data = (ctx.callbackQuery as any)?.data as string | undefined;
  await ctx.answerCbQuery();

  switch (data) {
    case "menu:wallet":
      return walletCommand(ctx);
    case "menu:settings":
      return settingsCommand(ctx);
    case "menu:referral":
      return referralCommand(ctx);
    case "menu:leaderboard":
      return leaderboardCommand(ctx);
    case "menu:share":
      return shareCommand(ctx);
    default:
      return;
  }
}
