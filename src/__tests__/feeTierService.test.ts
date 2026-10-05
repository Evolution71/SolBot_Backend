import { computeEffectiveFeeBps } from "../services/feeTierService";

describe("computeEffectiveFeeBps", () => {
  it("waives the fee entirely for a brand-new user's first trades", () => {
    const result = computeEffectiveFeeBps({ priorTradeCount: 0, referralCount: 0, baseFeeBps: 100 });
    expect(result.feeBps).toBe(0);
  });

  it("still waives the fee just under the welcome threshold", () => {
    const result = computeEffectiveFeeBps({ priorTradeCount: 2, referralCount: 0, baseFeeBps: 100 });
    expect(result.feeBps).toBe(0);
  });

  it("charges the standard fee once the welcome trades are used up", () => {
    const result = computeEffectiveFeeBps({ priorTradeCount: 3, referralCount: 0, baseFeeBps: 100 });
    expect(result.feeBps).toBe(100);
  });

  it("applies the mid referral discount tier", () => {
    const result = computeEffectiveFeeBps({ priorTradeCount: 10, referralCount: 3, baseFeeBps: 100 });
    expect(result.feeBps).toBe(75);
  });

  it("applies the top referral discount tier over the mid tier", () => {
    const result = computeEffectiveFeeBps({ priorTradeCount: 10, referralCount: 15, baseFeeBps: 100 });
    expect(result.feeBps).toBe(50);
  });

  it("welcome offer takes priority even for a high-referral user with few trades", () => {
    const result = computeEffectiveFeeBps({ priorTradeCount: 1, referralCount: 20, baseFeeBps: 100 });
    expect(result.feeBps).toBe(0);
  });

  it("falls back to the configured base fee with no discounts", () => {
    const result = computeEffectiveFeeBps({ priorTradeCount: 50, referralCount: 0, baseFeeBps: 150 });
    expect(result.feeBps).toBe(150);
  });
});
