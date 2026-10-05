import dotenv from "dotenv";
dotenv.config();

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    // Fail loudly at boot rather than at first trade — this is a financial app.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || "development",
  logLevel: process.env.LOG_LEVEL || "info",

  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || "",
  },

  solana: {
    rpcUrl: required("SOLANA_RPC_URL"),
    wsUrl: process.env.SOLANA_WS_URL || "",
    jupiterApiUrl: process.env.JUPITER_API_URL || "https://quote-api.jup.ag/v6",
    defaultSlippageBps: Number(process.env.DEFAULT_SLIPPAGE_BPS || 300),
    platformFeeBps: Number(process.env.PLATFORM_FEE_BPS || 100),
    // Falls back to the operator's configured wallet if the env var isn't
    // set, so the bot still collects fees even if this step gets missed
    // during deployment. Override via PLATFORM_FEE_WALLET in production.
    platformFeeWallet:
      process.env.PLATFORM_FEE_WALLET || "469rxFHREhqpKcDBugswHFzvuCpuqzWhcSyWfvY8TrL3",
  },

  helius: {
    webhookSecret: process.env.HELIUS_WEBHOOK_SECRET || "",
    apiKey: process.env.HELIUS_API_KEY || "",
  },

  supabase: {
    url: required("SUPABASE_URL"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    anonKey: process.env.SUPABASE_ANON_KEY || "",
  },

  security: {
    walletEncryptionKey: required("WALLET_ENCRYPTION_KEY"),
    jwtSecret: required("JWT_SECRET"),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
    // Comma-separated list of allowed frontend origins for CORS.
    corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  referral: {
    bonusSol: Number(process.env.REFERRAL_BONUS_SOL || 0),
    weeklyPrizeSol: Number(process.env.WEEKLY_LEADERBOARD_PRIZE_SOL || 1),
  },

  monitoring: {
    // Generic incoming webhook URL (Slack/Discord/Telegram-admin-chat all
    // accept a simple POST-JSON payload) that gets pinged on unhandled
    // errors and failed trades. Optional — logging still happens without it.
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || "",
  },

  mev: {
    // Jito block-engine endpoint for bundle submission (MEV/sandwich
    // protection). Leave blank to fall back to plain RPC submission.
    jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL || "",
    jitoTipAccount: process.env.JITO_TIP_ACCOUNT || "",
    jitoTipLamports: Number(process.env.JITO_TIP_LAMPORTS || 100_000),
    // Reject swaps whose quoted price impact exceeds this percentage unless
    // the user explicitly confirms (see snipeService/bot confirmation flow).
    maxPriceImpactPctDefault: Number(process.env.MAX_PRICE_IMPACT_PCT || 5),
  },

  turnstile: {
    // Cloudflare Turnstile secret key, from https://dash.cloudflare.com/
    // -> Turnstile. Used to verify CAPTCHA tokens server-side — the
    // frontend's site key alone proves nothing without this check.
    secretKey: process.env.TURNSTILE_SECRET_KEY || "",
  },
};
