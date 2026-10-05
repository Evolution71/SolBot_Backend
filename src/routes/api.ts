import { Router } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { getWeeklyLeaderboard } from "../services/leaderboardService";
import { getReferralStats } from "../services/referralService";
import { getRecentTrades, getTradeSummary } from "../services/tradeService";
import { getOrCreateWallet, getSolBalance, getTokenBalanceRaw } from "../services/walletService";
import { getPortfolioPnl } from "../services/pnlService";
import { getAutopilotSettings, updateAutopilotSettings, acceptAutopilotTerms } from "../services/autopilotService";
import { RiskLevel, assessTokenRisk } from "../services/riskAnalysisService";
import { previewBuy, previewSell, isValidMint } from "../services/jupiterService";
import { getEffectiveFeeBps } from "../services/feeTierService";
import { manualSnipe, manualSell, computeSellAmountRaw } from "../services/snipeService";
import { requireAcceptedTerms, acceptTerms } from "../services/complianceService";

export const apiRouter = Router();

// Public: no sensitive per-user data, safe for anyone to read.
apiRouter.get("/leaderboard", async (_req, res) => {
  try {
    const entries = await getWeeklyLeaderboard(50);
    res.json({ entries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Everything below requires a valid session issued by POST /api/auth/telegram.
// The telegram user id comes from the verified JWT (req.auth), never from a
// client-supplied path param -- so one user can no longer enumerate another
// user's wallet balance, trades, or referral stats.
apiRouter.use(requireAuth);

apiRouter.get("/me/summary", async (req: AuthedRequest, res) => {
  try {
    const telegramUserId = req.auth!.telegramUserId;
    const [wallet, summary, referral] = await Promise.all([
      getOrCreateWallet(telegramUserId),
      getTradeSummary(telegramUserId),
      getReferralStats(telegramUserId),
    ]);
    const balance = await getSolBalance(wallet.publicKey);

    res.json({
      wallet: { publicKey: wallet.publicKey, balanceSol: balance },
      trades: summary,
      referral,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get("/me/trades", async (req: AuthedRequest, res) => {
  try {
    const telegramUserId = req.auth!.telegramUserId;
    const limit = Number(req.query.limit ?? 20);
    const trades = await getRecentTrades(telegramUserId, limit);
    res.json({ trades });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get("/me/pnl", async (req: AuthedRequest, res) => {
  try {
    const telegramUserId = req.auth!.telegramUserId;
    const pnl = await getPortfolioPnl(telegramUserId);
    res.json(pnl);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Autopilot settings — the same underlying config as /autopilot config in
// Telegram, exposed here so the website's Execution Parameters panel and
// Strategy Presets can read/write it too. Both surfaces operate on the
// same row per user, so a change in one shows up in the other immediately.
apiRouter.get("/me/autopilot", async (req: AuthedRequest, res) => {
  try {
    const settings = await getAutopilotSettings(req.auth!.telegramUserId);
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put("/me/autopilot", async (req: AuthedRequest, res) => {
  try {
    const telegramUserId = req.auth!.telegramUserId;
    const body = req.body ?? {};

    // Turning autopilot ON requires the same explicit risk disclosure
    // acceptance the bot enforces — the website can't bypass that gate.
    if (body.enabled === true) {
      const current = await getAutopilotSettings(telegramUserId);
      if (!current.autopilotTermsAcceptedAt) {
        return res.status(403).json({
          error: "Accept the Autopilot risk disclosure first.",
          requiresAcceptance: true,
        });
      }
    }

    const patch: Record<string, unknown> = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.maxBuySol === "number") patch.maxBuySol = body.maxBuySol;
    if (typeof body.budgetSol === "number") patch.budgetSol = body.budgetSol;
    if (typeof body.minLiquiditySol === "number") patch.minLiquiditySol = body.minLiquiditySol;
    if (["low", "medium", "high"].includes(body.maxRiskLevel)) patch.maxRiskLevel = body.maxRiskLevel as RiskLevel;
    if (typeof body.takeProfitPct === "number") patch.takeProfitPct = body.takeProfitPct;
    if (typeof body.stopLossPct === "number") patch.stopLossPct = body.stopLossPct;

    await updateAutopilotSettings(telegramUserId, patch);
    const updated = await getAutopilotSettings(telegramUserId);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/me/autopilot/accept", async (req: AuthedRequest, res) => {
  try {
    await acceptAutopilotTerms(req.auth!.telegramUserId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Manual web trading — the website's own Buy/Sell forms hit these, using the
// exact same custodial engine (encrypted per-user wallet, fee-aware Jupiter
// swaps, MEV-aware submission) that the Telegram /snipe and /sell commands
// use. This is what lets trading happen entirely from the website: no
// Telegram command required, same security model, same fee tiers.
// ---------------------------------------------------------------------------

apiRouter.get("/me/terms", async (req: AuthedRequest, res) => {
  try {
    const gate = await requireAcceptedTerms(req.auth!.telegramUserId);
    res.json({ accepted: gate.accepted, message: gate.accepted ? null : gate.message });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/me/terms/accept", async (req: AuthedRequest, res) => {
  try {
    await acceptTerms(req.auth!.telegramUserId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/me/trade/preview-buy", async (req: AuthedRequest, res) => {
  try {
    const { tokenMint, solAmount } = req.body ?? {};
    if (!isValidMint(tokenMint)) return res.status(400).json({ error: "Invalid token address." });
    if (!Number.isFinite(solAmount) || solAmount <= 0) {
      return res.status(400).json({ error: "SOL amount must be a positive number." });
    }

    const telegramUserId = req.auth!.telegramUserId;
    const [fee, risk] = await Promise.all([
      getEffectiveFeeBps(telegramUserId),
      assessTokenRisk(tokenMint),
    ]);
    const preview = await previewBuy({ tokenMint, solAmount, feeBps: fee.feeBps });

    res.json({ fee, risk, preview });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post("/me/trade/buy", async (req: AuthedRequest, res) => {
  try {
    const telegramUserId = req.auth!.telegramUserId;
    const gate = await requireAcceptedTerms(telegramUserId);
    if (!gate.accepted) return res.status(403).json({ error: gate.message, requiresAcceptance: true });

    const { tokenMint, solAmount, takeProfitPct, stopLossPct } = req.body ?? {};
    if (!isValidMint(tokenMint)) return res.status(400).json({ error: "Invalid token address." });
    if (!Number.isFinite(solAmount) || solAmount <= 0) {
      return res.status(400).json({ error: "SOL amount must be a positive number." });
    }

    const result = await manualSnipe({
      telegramUserId,
      tokenMint,
      solAmount,
      takeProfitPct: typeof takeProfitPct === "number" ? takeProfitPct : null,
      stopLossPct: typeof stopLossPct === "number" ? stopLossPct : null,
    });

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post("/me/trade/preview-sell", async (req: AuthedRequest, res) => {
  try {
    const { tokenMint, percent } = req.body ?? {};
    if (!isValidMint(tokenMint)) return res.status(400).json({ error: "Invalid token address." });
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      return res.status(400).json({ error: "Percent must be between 1 and 100." });
    }

    const telegramUserId = req.auth!.telegramUserId;
    const wallet = await getOrCreateWallet(telegramUserId);
    const balanceRaw = await getTokenBalanceRaw(wallet.publicKey, tokenMint);
    if (balanceRaw <= 0) return res.status(400).json({ error: "You don't hold any of that token." });

    const tokenAmountRaw = computeSellAmountRaw(balanceRaw, percent);
    const fee = await getEffectiveFeeBps(telegramUserId);
    const preview = await previewSell({ tokenMint, tokenAmountRaw, feeBps: fee.feeBps });

    res.json({ fee, preview });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post("/me/trade/sell", async (req: AuthedRequest, res) => {
  try {
    const telegramUserId = req.auth!.telegramUserId;
    const gate = await requireAcceptedTerms(telegramUserId);
    if (!gate.accepted) return res.status(403).json({ error: gate.message, requiresAcceptance: true });

    const { tokenMint, percent } = req.body ?? {};
    if (!isValidMint(tokenMint)) return res.status(400).json({ error: "Invalid token address." });
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      return res.status(400).json({ error: "Percent must be between 1 and 100." });
    }

    const result = await manualSell({ telegramUserId, tokenMint, percent });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
