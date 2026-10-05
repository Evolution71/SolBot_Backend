import { Context } from "telegraf";
import { getOrCreateWallet, getSolBalance, exportPrivateKeyForOwner } from "../../services/walletService";

export async function walletCommand(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);
  if (!telegramUserId) return;

  const wallet = await getOrCreateWallet(telegramUserId);
  const balance = await getSolBalance(wallet.publicKey);

  await ctx.reply(
    [
      "*Your Trading Wallet*",
      `Address: \`${wallet.publicKey}\``,
      `Balance: *${balance.toFixed(4)} SOL*`,
      "",
      "Deposit SOL to this address to fund trades. Use /export if you ever want the private key to import elsewhere — it's your wallet, your keys.",
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

export async function exportCommand(ctx: Context) {
  const telegramUserId = String(ctx.from?.id);
  if (!telegramUserId) return;

  // In production: require an explicit confirmation button before revealing
  // the key, and rate-limit this heavily. Telegraf scenes/wizards or an
  // inline-keyboard confirm step both work well here.
  const privateKeyBase58 = await exportPrivateKeyForOwner(telegramUserId);

  await ctx.reply(
    [
      "*Your private key (base58)* — shown once, in a message that will vanish from chat history if you delete it. Never share this with anyone, including someone claiming to be NEXUS SOL BOT support.",
      "",
      `\`${privateKeyBase58}\``,
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}
