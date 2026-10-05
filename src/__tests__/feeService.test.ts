import { computeBuyFeeLamports, computeSellFeeLamports } from "../services/feeService";

describe("computeBuyFeeLamports", () => {
  it("takes 1% (100 bps) of the spend amount", () => {
    expect(computeBuyFeeLamports(1_000_000_000, 100)).toBe(10_000_000); // 1 SOL -> 0.01 SOL fee
  });

  it("takes 0 fee at 0 bps", () => {
    expect(computeBuyFeeLamports(1_000_000_000, 0)).toBe(0);
  });

  it("floors fractional lamports rather than rounding up (never over-charges)", () => {
    expect(computeBuyFeeLamports(999, 100)).toBe(9); // 9.99 -> 9
  });
});

describe("computeSellFeeLamports", () => {
  it("computes fee against the guaranteed-minimum output, not the optimistic quote", () => {
    // 1 SOL quoted out, 3% slippage tolerance -> guaranteed min = 0.97 SOL
    // 1% fee of that guaranteed min = 0.0097 SOL = 9,700,000 lamports
    const fee = computeSellFeeLamports(1_000_000_000, 300, 100);
    expect(fee).toBe(9_700_000);
  });

  it("never exceeds what a worst-case-slippage fill would actually return", () => {
    const quotedOut = 5_000_000_000;
    const slippageBps = 500; // 5%
    const feeBps = 100;
    const fee = computeSellFeeLamports(quotedOut, slippageBps, feeBps);
    const guaranteedMin = Math.floor((quotedOut * (10_000 - slippageBps)) / 10_000);
    expect(fee).toBeLessThanOrEqual(guaranteedMin);
  });

  it("returns 0 fee at 0 bps regardless of slippage", () => {
    expect(computeSellFeeLamports(1_000_000_000, 300, 0)).toBe(0);
  });
});
