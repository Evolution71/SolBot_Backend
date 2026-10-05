import { Context, Markup } from "telegraf";
import { addWatch, computeSellAmountRaw } from "../../services/snipeService";
import { requireAcceptedTerms } from "../../services/complianceService";
import { previewBuy, previewSell, isValidMint } from "../../services/jupiterService";
import { getEffectiveFeeBps } from "../../services/feeTierService";
import { getOrCreateWallet, getTokenBalanceRaw } from "../../services/walletService";
import { createPendingTrade } from "../../services/pendingTradeStore";
import { assessTokenRisk } from "../../services/riskAnalysisService";

function parseArgs(ctx: Context): string[] {
  const text = "text" in (ctx.message ?? {}) ? (ctx.message as any).text : "";
  return text.trim().split(/\s+/).slice(1);
}

function lamportsToSol(lamports: number): string {
  return (lamports / 1_000_000_000).toFixed(4);
}

const RISK_EMOJI: Record<string, string> = { low: "\u{1F7E2}", medium: "\u{1F7E1}", high: "\u{1F534}" };

export async function checkCommand(ctx: Context) {
  const [tokenMint] = parseArgs(ctx);
  if (!tokenMint || !isValidMint(tokenMint)) {
    return ctx.reply("Usage: `/check <token_address>`", { parse_mode: "Markdown" });
  }

  const status = await ctx.reply("\u{1F50D} Analyzing token...");
  try {
    const risk = await assessTokenRisk(tokenMint);
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      status.message_id,
      undefined,
      [
        `${RISK_EMOJI[risk.level]} *Risk: ${risk.level.toUpperCase()}* (score ${risk.score}/100)`,
        "",
        ...risk.reasons.map((r) => `\u2022 ${r}`),
        "",
        "_This is a heuristic screen for common rug patterns (mint/freeze authority, holder concentration, liquidity depth) — it can't catch everything, and a low score is not a promise the token will perform well. Always size positions accordingly._",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (err: any) {
    await ctx.telegram.editMessageText(ctx.chat!.id, status.message_id, undefined, `Couldn't analyze that token: ${err.message}`);
  }
}

export async function snipeCommand(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);

  const gate = await requireAcceptedTerms(telegramUserId);
  if (!gate.accepted) return ctx.reply(gate.message, { parse_mode: "Markdown" });

  // /snipe <token> <sol> [takeProfitPct] [stopLossPct]
  const [tokenMint, amountStr, tpStr, slStr] = parseArgs(ctx);

  if (!tokenMint || !amountStr) {
    return ctx.reply(
      "Usage: `/snipe <token_address> <sol_amount> [take_profit_%] [stop_loss_%]`\n" +
        "Example: `/snipe EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 0.5 50 20`\n" +
        "(spend 0.5 SOL, auto-sell at +50% or -20%)",
      { parse_mode: "Markdown" }
    );
  }
  if (!isValidMint(tokenMint)) {
    return ctx.reply("That doesn't look like a valid Solana token address.");
  }

  const solAmount = Number(amountStr);
  if (!Number.isFinite(solAmount) || solAmount <= 0) {
    return ctx.reply("SOL amount must be a positive number.");
  }

  const takeProfitPct = tpStr ? Number(tpStr) : null;
  const stopLossPct = slStr ? Number(slStr) : null;
  if (tpStr && (!Number.isFinite(takeProfitPct) || (takeProfitPct as number) <= 0)) {
    return ctx.reply("Take-profit % must be a positive number.");
  }
  if (slStr && (!Number.isFinite(stopLossPct) || (stopLossPct as number) <= 0 || (stopLossPct as number) >= 100)) {
    return ctx.reply("Stop-loss % must be a positive number under 100.");
  }

  const statusMsg = await ctx.reply("\u{1F50D} Fetching a quote and analyzing the token...");

  try {
    const [fee, risk] = await Promise.all([
      getEffectiveFeeBps(telegramUserId),
      assessTokenRisk(tokenMint),
    ]);
    const preview = await previewBuy({ tokenMint, solAmount, feeBps: fee.feeBps });

    const outTokens = Number(preview.outAmount) / 10 ** preview.outputDecimals;
    const impactPct = (Number(preview.priceImpactPct) * 100).toFixed(2);
    const feeSol = lamportsToSol(preview.feeLamports);
    const feeLine =
      preview.feeBps === 0
        ? `Fee: *FREE* — ${fee.reason}`
        : `Fee: ${feeSol} SOL (${(preview.feeBps / 100).toFixed(2)}%) — ${fee.reason}`;

    const tpslLine =
      takeProfitPct || stopLossPct
        ? `Auto-exit: ${takeProfitPct ? `TP +${takeProfitPct}%` : "no TP"} / ${stopLossPct ? `SL -${stopLossPct}%` : "no SL"}`
        : "Auto-exit: none set (sell manually with /sell)";

    const id = createPendingTrade({
      kind: "buy",
      telegramUserId,
      tokenMint,
      solAmount,
      feeBps: fee.feeBps,
      takeProfitPct,
      stopLossPct,
    });

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      undefined,
      [
        "*Confirm your snipe*",
        `${RISK_EMOJI[risk.level]} Risk: ${risk.level.toUpperCase()} (${risk.reasons[0]})`,
        `Spend: ${solAmount} SOL`,
        `Est. receive: ~${outTokens.toLocaleString(undefined, { maximumFractionDigits: 4 })} tokens`,
        `Price impact: ${impactPct}%`,
        feeLine,
        tpslLine,
        "",
        "_Quote is indicative — final fill may vary slightly. Expires in 2 minutes. Run /check <token> anytime for the full risk breakdown._",
      ].join("\n"),
      {
        parse_mode: "Markdown",
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback("\u2705 Confirm", `confirm_trade:${id}`),
          Markup.button.callback("\u274C Cancel", `cancel_trade:${id}`),
        ]).reply_markup,
      }
    );
  } catch (err: any) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      undefined,
      `\u274C Couldn't get a quote: ${err.message ?? "unknown error"}`
    );
  }
}

export async function sellCommand(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);

  const gate = await requireAcceptedTerms(telegramUserId);
  if (!gate.accepted) return ctx.reply(gate.message, { parse_mode: "Markdown" });

  const [tokenMint, percentStr] = parseArgs(ctx);

  if (!tokenMint || !percentStr) {
    return ctx.reply("Usage: `/sell <token_address> <percent>` (e.g. `/sell <CA> 100` to sell everything)", {
      parse_mode: "Markdown",
    });
  }
  if (!isValidMint(tokenMint)) {
    return ctx.reply("That doesn't look like a valid Solana token address.");
  }

  const percent = Number(percentStr);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return ctx.reply("Percent must be a number between 1 and 100.");
  }

  const statusMsg = await ctx.reply("\u{1F50D} Fetching a quote...");

  try {
    const wallet = await getOrCreateWallet(telegramUserId);
    const balanceRaw = await getTokenBalanceRaw(wallet.publicKey, tokenMint);
    if (balanceRaw <= 0) {
      return ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        "You don't hold any of that token in your trading wallet."
      );
    }

    const tokenAmountRaw = computeSellAmountRaw(balanceRaw, percent);
    const fee = await getEffectiveFeeBps(telegramUserId);
    const preview = await previewSell({ tokenMint, tokenAmountRaw, feeBps: fee.feeBps });

    const impactPct = (Number(preview.priceImpactPct) * 100).toFixed(2);
    const feeSol = lamportsToSol(preview.feeLamports);
    const grossSol = lamportsToSol(Number(preview.outAmount));
    const feeLine =
      preview.feeBps === 0
        ? `Fee: *FREE* — ${fee.reason}`
        : `Fee: ~${feeSol} SOL (${(preview.feeBps / 100).toFixed(2)}%) — ${fee.reason}`;

    const id = createPendingTrade({ kind: "sell", telegramUserId, tokenMint, percent, feeBps: fee.feeBps });

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      undefined,
      [
        "*Confirm your sell*",
        `Sell: ${percent}% of your holding`,
        `Est. receive: ~${grossSol} SOL (before fee)`,
        `Price impact: ${impactPct}%`,
        feeLine,
        "",
        "_Quote is indicative — final fill may vary slightly. Expires in 2 minutes._",
      ].join("\n"),
      {
        parse_mode: "Markdown",
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback("\u2705 Confirm", `confirm_trade:${id}`),
          Markup.button.callback("\u274C Cancel", `cancel_trade:${id}`),
        ]).reply_markup,
      }
    );
  } catch (err: any) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      undefined,
      `\u274C Couldn't get a quote: ${err.message ?? "unknown error"}`
    );
  }
}

export async function watchCommand(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);

  const gate = await requireAcceptedTerms(telegramUserId);
  if (!gate.accepted) return ctx.reply(gate.message, { parse_mode: "Markdown" });

  const [tokenMint, amountStr] = parseArgs(ctx);

  if (!tokenMint || !amountStr) {
    return ctx.reply("Usage: `/watch <token_address> <sol_amount>`", { parse_mode: "Markdown" });
  }

  const solAmount = Number(amountStr);
  if (!Number.isFinite(solAmount) || solAmount <= 0) {
    return ctx.reply("SOL amount must be a positive number.");
  }

  try {
    await addWatch(telegramUserId, tokenMint, solAmount);
    await ctx.reply(
      `\u{1F440} Watching \`${tokenMint}\`. I'll auto-buy ${solAmount} SOL worth the moment it's detected live — same fee terms as a manual /snipe. For risk-gated hands-off buying across ALL new launches, see /autopilot instead.`,
      { parse_mode: "Markdown" }
    );
  } catch (err: any) {
    await ctx.reply(`Couldn't add watch: ${err.message}`);
  }
}
