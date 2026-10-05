import { supabase } from "../db/supabase";
import { getTokenPricesUsd } from "./priceService";

interface TradeRow {
  token_mint: string;
  side: "buy" | "sell";
  sol_amount: number;
  token_amount_raw: number;
  token_decimals: number;
  created_at: string;
}

interface Lot {
  tokenAmount: number; // human units
  costSol: number; // SOL paid for this lot (proportional on partial fills)
}

export interface TokenPosition {
  tokenMint: string;
  openTokenAmount: number;
  costBasisSol: number;
  realizedPnlSol: number;
  currentPriceUsd: number | null;
  unrealizedPnlUsd: number | null;
}

export interface PortfolioPnl {
  positions: TokenPosition[];
  totalRealizedPnlSol: number;
  totalUnrealizedPnlUsd: number | null;
}

/**
 * Pure FIFO matcher — no I/O, fully unit-testable. Takes a chronologically
 * ordered list of trades for one user (any number of token mints mixed
 * together) and returns per-token realized PNL and open-lot cost basis.
 * Exported separately from getPortfolioPnl so tests don't need to mock
 * Supabase or the price oracle to exercise the matching logic itself.
 */
export function computeFifoPositions(trades: TradeRow[]): {
  positions: TokenPosition[];
  totalRealizedPnlSol: number;
} {
  const byToken = new Map<string, TradeRow[]>();
  for (const row of trades) {
    const list = byToken.get(row.token_mint) ?? [];
    list.push(row);
    byToken.set(row.token_mint, list);
  }

  const positions: TokenPosition[] = [];
  let totalRealizedPnlSol = 0;

  for (const [tokenMint, trades] of byToken.entries()) {
    const openLots: Lot[] = [];
    let realizedPnlSol = 0;

    for (const t of trades) {
      const tokenAmount = t.token_amount_raw / 10 ** t.token_decimals;

      if (t.side === "buy") {
        openLots.push({ tokenAmount, costSol: t.sol_amount });
        continue;
      }

      // Sell: consume open lots FIFO, proportionally attributing cost basis.
      let remainingToSell = tokenAmount;
      let costOfSoldPortion = 0;

      while (remainingToSell > 1e-12 && openLots.length > 0) {
        const lot = openLots[0];
        const take = Math.min(lot.tokenAmount, remainingToSell);
        const proportion = lot.tokenAmount > 0 ? take / lot.tokenAmount : 0;
        const costForTake = lot.costSol * proportion;

        costOfSoldPortion += costForTake;
        lot.tokenAmount -= take;
        lot.costSol -= costForTake;
        remainingToSell -= take;

        if (lot.tokenAmount <= 1e-12) openLots.shift();
      }

      // Proceeds for this sell in SOL vs. the cost basis of what was sold.
      realizedPnlSol += t.sol_amount - costOfSoldPortion;
    }

    const openTokenAmount = openLots.reduce((sum, l) => sum + l.tokenAmount, 0);
    const costBasisSol = openLots.reduce((sum, l) => sum + l.costSol, 0);

    totalRealizedPnlSol += realizedPnlSol;

    positions.push({
      tokenMint,
      openTokenAmount,
      costBasisSol,
      realizedPnlSol,
      currentPriceUsd: null,
      unrealizedPnlUsd: null,
    });
  }

  return { positions, totalRealizedPnlSol };
}

/**
 * Fetches a user's trade history, runs it through the FIFO matcher, then
 * enriches open positions with live USD pricing for unrealized PNL.
 */
export async function getPortfolioPnl(telegramUserId: string): Promise<PortfolioPnl> {
  const { data, error } = await supabase
    .from("trades")
    .select("token_mint, side, sol_amount, token_amount_raw, token_decimals, created_at")
    .eq("telegram_user_id", telegramUserId)
    .order("created_at", { ascending: true });

  if (error) throw error;

  const { positions, totalRealizedPnlSol } = computeFifoPositions((data ?? []) as TradeRow[]);

  // Only bother pricing tokens with an open position.
  const openPositions = positions.filter((p) => p.openTokenAmount > 1e-9);
  const prices = await getTokenPricesUsd(openPositions.map((p) => p.tokenMint));

  let totalUnrealizedPnlUsd: number | null = 0;
  let anyPriceMissing = false;

  for (const p of positions) {
    if (p.openTokenAmount <= 1e-9) continue;
    const price = prices[p.tokenMint];
    p.currentPriceUsd = price ?? null;

    if (price == null) {
      anyPriceMissing = true;
      continue;
    }

    // Cost basis is in SOL; we don't have a SOL/USD rate wired in here, so
    // unrealized PNL is expressed in USD against current market value only
    // when you extend this with a SOL/USD price too. For now we report
    // current market value; wire in a SOL/USD feed to net against cost
    // basis if you want a single blended USD PNL figure.
    const marketValueUsd = p.openTokenAmount * price;
    p.unrealizedPnlUsd = marketValueUsd; // market value, see note above
    totalUnrealizedPnlUsd = (totalUnrealizedPnlUsd ?? 0) + marketValueUsd;
  }

  return {
    positions,
    totalRealizedPnlSol,
    totalUnrealizedPnlUsd: anyPriceMissing ? null : totalUnrealizedPnlUsd,
  };
}
