import axios from "axios";
import { logger } from "../utils/logger";

const JUPITER_PRICE_API = "https://api.jup.ag/price/v2";
const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  price: number;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Returns the current USD price for a token mint, using Jupiter's price
 * API with a short in-memory cache to avoid hammering it during a burst of
 * /pnl or dashboard requests. Returns null if the price can't be resolved
 * (e.g. a brand-new token with no route yet) — callers should treat that as
 * "unrealized PNL unavailable" rather than crashing.
 */
export async function getTokenPriceUsd(mint: string): Promise<number | null> {
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.price;
  }

  try {
    const { data } = await axios.get(JUPITER_PRICE_API, {
      params: { ids: mint },
      timeout: 5000,
    });
    const price = data?.data?.[mint]?.price;
    if (typeof price !== "number") return null;

    cache.set(mint, { price, fetchedAt: Date.now() });
    return price;
  } catch (err) {
    logger.warn({ err, mint }, "Price lookup failed");
    return cached?.price ?? null;
  }
}

export async function getTokenPricesUsd(mints: string[]): Promise<Record<string, number | null>> {
  const uniqueMints = Array.from(new Set(mints));
  const results = await Promise.all(uniqueMints.map((m) => getTokenPriceUsd(m)));
  return Object.fromEntries(uniqueMints.map((m, i) => [m, results[i]]));
}
