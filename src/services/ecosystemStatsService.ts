import axios from "axios";
import { logger } from "../utils/logger";

/**
 * Pulls real, publicly verifiable Solana DEX activity from DefiLlama's
 * open API (no key required, no rate-limit issues for this volume).
 * https://defillama.com/docs/api
 *
 * Deliberately does NOT include pump.fun-specific stats (new launches,
 * "graduated", "rugged", survival rate) — there's no stable, documented
 * public API for those figures, and inventing plausible-looking numbers
 * would break the same transparency standard the rest of this project
 * holds to (real fees, real leaderboard, real trade history). If you have
 * a paid data provider for that later, wire it in here.
 */

const CACHE_TTL_MS = 60_000;
let cache: { data: EcosystemStats; fetchedAt: number } | null = null;

export interface EcosystemStats {
  solanaDexVolume24hUsd: number | null;
  solanaTvlUsd: number | null;
  source: string;
  fetchedAt: string;
}

export async function getEcosystemStats(): Promise<EcosystemStats> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  let solanaDexVolume24hUsd: number | null = null;
  let solanaTvlUsd: number | null = null;

  try {
    const { data } = await axios.get("https://api.llama.fi/overview/dexs/solana", {
      params: { excludeTotalDataChart: true, excludeTotalDataChartBreakdown: true },
      timeout: 8000,
    });
    solanaDexVolume24hUsd = data?.total24h ?? null;
  } catch (err) {
    logger.warn({ err }, "Failed to fetch Solana DEX volume from DefiLlama");
  }

  try {
    const { data } = await axios.get("https://api.llama.fi/v2/chains", { timeout: 8000 });
    const solana = Array.isArray(data) ? data.find((c: any) => c.name === "Solana") : null;
    solanaTvlUsd = solana?.tvl ?? null;
  } catch (err) {
    logger.warn({ err }, "Failed to fetch Solana TVL from DefiLlama");
  }

  const result: EcosystemStats = {
    solanaDexVolume24hUsd,
    solanaTvlUsd,
    source: "DefiLlama (api.llama.fi)",
    fetchedAt: new Date().toISOString(),
  };

  cache = { data: result, fetchedAt: Date.now() };
  return result;
}
