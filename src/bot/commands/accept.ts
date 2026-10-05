import { Context } from "telegraf";
import { acceptTerms } from "../../services/complianceService";

export async function acceptCommand(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);
  await acceptTerms(telegramUserId);
  await ctx.reply(
    "Thanks — you're clear to trade. Start with /snipe <token_address> <sol_amount>, or /watch to queue an auto-buy."
  );
}
