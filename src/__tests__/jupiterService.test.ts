import { checkPriceImpact, PriceImpactTooHighError } from "../services/jupiterService";

describe("checkPriceImpact", () => {
  it("allows a trade under the threshold", () => {
    expect(() => checkPriceImpact(0.02, 5)).not.toThrow(); // 2% < 5%
  });

  it("allows a trade exactly at the threshold", () => {
    expect(() => checkPriceImpact(0.05, 5)).not.toThrow(); // 5% == 5%, not >
  });

  it("rejects a trade over the threshold", () => {
    expect(() => checkPriceImpact(0.081, 5)).toThrow(PriceImpactTooHighError);
  });

  it("carries the computed percentage on the thrown error", () => {
    try {
      checkPriceImpact(0.123, 5);
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PriceImpactTooHighError);
      expect((err as PriceImpactTooHighError).priceImpactPct).toBeCloseTo(12.3);
      expect((err as PriceImpactTooHighError).maxAllowedPct).toBe(5);
    }
  });

  it("does not throw on a non-numeric/undefined impact (fails open on missing data)", () => {
    expect(() => checkPriceImpact("not-a-number", 5)).not.toThrow();
  });
});
