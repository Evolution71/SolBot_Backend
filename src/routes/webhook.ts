import { Router } from "express";
import { config } from "../config";
import { handleNewPoolEvent } from "../services/snipeService";
import { runAutopilotForAllUsers } from "../services/autopilotService";
import { recordDetection } from "../services/feedService";
import { logger } from "../utils/logger";

export const webhookRouter = Router();

/**
 * Helius (or Shyft/QuickNode) sends a POST here whenever a new liquidity
 * pool / token mint matching your configured program filters is detected.
 * Configure the webhook at https://dev.helius.xyz to watch Raydium/Pump.fun
 * program addresses and POST here.
 *
 * Every detected token fans out to three independent systems:
 * 1. handleNewPoolEvent — executes any explicit per-token /watch orders.
 * 2. runAutopilotForAllUsers — runs the risk/liquidity gate for every user
 *    who has Autopilot enabled, and buys automatically if it clears their
 *    configured thresholds. This is the fully-hands-off mode.
 * 3. recordDetection — logs the risk assessment regardless of outcome, for
 *    the public Live Feed on the website.
 */
webhookRouter.post("/new-pool", async (req, res) => {
  const secret = req.header("x-webhook-secret");
  if (!config.helius.webhookSecret || secret !== config.helius.webhookSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const event of events) {
      // Shape depends on your Helius webhook config (raw tx vs enhanced).
      // Adjust this extraction to match whatever field holds the new mint.
      const tokenMint: string | undefined =
        event?.tokenTransfers?.[0]?.mint ?? event?.mint ?? event?.tokenMint;

      if (tokenMint) {
        await Promise.all([
          handleNewPoolEvent(tokenMint),
          runAutopilotForAllUsers(tokenMint),
          recordDetection(tokenMint),
        ]);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Error processing new-pool webhook");
    res.status(500).json({ error: "internal error" });
  }
});
