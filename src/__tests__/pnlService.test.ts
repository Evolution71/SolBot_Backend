import { computeFifoPositions } from "../services/pnlService";

const MINT = "TokenMintAAA111";

function trade(
  side: "buy" | "sell",
  solAmount: number,
  tokenAmountRaw: number,
  decimals = 9,
  atOffsetSeconds = 0
) {
  return {
    token_mint: MINT,
    side,
    sol_amount: solAmount,
    token_amount_raw: tokenAmountRaw,
    token_decimals: decimals,
    created_at: new Date(Date.now() + atOffsetSeconds * 1000).toISOString(),
  };
}

describe("computeFifoPositions", () => {
  it("computes zero PNL and full cost basis for a single open buy", () => {
    const trades = [trade("buy", 1, 1000 * 1e9, 9, 0)];
    const { positions, totalRealizedPnlSol } = computeFifoPositions(trades);

    expect(totalRealizedPnlSol).toBe(0);
    expect(positions[0].openTokenAmount).toBeCloseTo(1000);
    expect(positions[0].costBasisSol).toBeCloseTo(1);
    expect(positions[0].realizedPnlSol).toBe(0);
  });

  it("computes positive realized PNL on a profitable full sell", () => {
    const trades = [
      trade("buy", 1, 1000 * 1e9, 9, 0), // spent 1 SOL for 1000 tokens
      trade("sell", 2, 1000 * 1e9, 9, 10), // sold all 1000 tokens for 2 SOL
    ];
    const { positions, totalRealizedPnlSol } = computeFifoPositions(trades);

    expect(totalRealizedPnlSol).toBeCloseTo(1); // 2 SOL proceeds - 1 SOL cost
    expect(positions[0].openTokenAmount).toBeCloseTo(0);
    expect(positions[0].realizedPnlSol).toBeCloseTo(1);
  });

  it("computes negative realized PNL on a losing sell", () => {
    const trades = [
      trade("buy", 2, 1000 * 1e9, 9, 0),
      trade("sell", 0.5, 1000 * 1e9, 9, 10),
    ];
    const { totalRealizedPnlSol } = computeFifoPositions(trades);
    expect(totalRealizedPnlSol).toBeCloseTo(-1.5);
  });

  it("matches partial sells FIFO across multiple buy lots", () => {
    const trades = [
      trade("buy", 1, 1000 * 1e9, 9, 0), // lot 1: 1000 tokens @ 1 SOL
      trade("buy", 3, 1000 * 1e9, 9, 10), // lot 2: 1000 tokens @ 3 SOL
      trade("sell", 1.5, 1500 * 1e9, 9, 20), // sells all of lot 1 + half of lot 2
    ];
    const { positions, totalRealizedPnlSol } = computeFifoPositions(trades);

    // Cost of sold portion = 1 (all of lot 1) + 1.5 (half of lot 2's 3 SOL) = 2.5
    // Proceeds = 1.5 SOL -> realized PNL = 1.5 - 2.5 = -1
    expect(totalRealizedPnlSol).toBeCloseTo(-1);
    // Remaining open: 500 tokens from lot 2, cost basis 1.5 SOL
    expect(positions[0].openTokenAmount).toBeCloseTo(500);
    expect(positions[0].costBasisSol).toBeCloseTo(1.5);
  });

  it("handles multiple token mints independently", () => {
    const otherMint = "TokenMintBBB222";
    const trades = [
      trade("buy", 1, 1000 * 1e9, 9, 0),
      { ...trade("buy", 5, 2000 * 1e9, 9, 5), token_mint: otherMint },
    ];
    const { positions } = computeFifoPositions(trades);
    expect(positions.map((p) => p.tokenMint).sort()).toEqual([MINT, otherMint].sort());
  });
});
