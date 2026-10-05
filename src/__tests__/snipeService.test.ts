import { computeSellAmountRaw } from "../services/snipeService";

describe("computeSellAmountRaw", () => {
  it("computes 100% as the full balance", () => {
    expect(computeSellAmountRaw(1_000_000, 100)).toBe(1_000_000);
  });

  it("computes 50% as half the balance", () => {
    expect(computeSellAmountRaw(1_000_000, 50)).toBe(500_000);
  });

  it("floors fractional results instead of overselling", () => {
    expect(computeSellAmountRaw(999, 33)).toBe(329); // 329.67 -> floor to 329
  });

  it("never exceeds the actual balance at 100%", () => {
    const balance = 123_456_789;
    expect(computeSellAmountRaw(balance, 100)).toBeLessThanOrEqual(balance);
  });

  it("returns 0 for a tiny balance at a low percentage", () => {
    expect(computeSellAmountRaw(2, 10)).toBe(0);
  });
});
