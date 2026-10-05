import { Router } from "express";
import { getRecentFeed } from "../services/feedService";
import { getEcosystemStats } from "../services/ecosystemStatsService";

export const publicDataRouter = Router();

publicDataRouter.get("/feed", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 50);
    const entries = await getRecentFeed(limit);
    res.json({ entries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

publicDataRouter.get("/ecosystem", async (_req, res) => {
  try {
    const stats = await getEcosystemStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
