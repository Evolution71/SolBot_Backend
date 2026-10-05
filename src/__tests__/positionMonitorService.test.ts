import { decideTrigger } from "../services/positionMonitorService";

describe("decideTrigger", () => {
  it("holds when price hasn't moved", () => {
    const decision = decideTrigger({
      entrySolAmount: 1,
      currentValueSol: 1,
      takeProfitPct: 50,
      stopLossPct: 20,
    });
    expect(decision).toBe("hold");
  });

  it("triggers take-profit exactly at the target", () => {
    // entry 1 SOL, +50% target -> 1.5 SOL
    const decision = decideTrigger({
      entrySolAmount: 1,
      currentValueSol: 1.5,
      takeProfitPct: 50,
      stopLossPct: 20,
    });
    expect(decision).toBe("take_profit");
  });

  it("triggers stop-loss exactly at the floor", () => {
    // entry 1 SOL, -20% floor -> 0.8 SOL
    const decision = decideTrigger({
      entrySolAmount: 1,
      currentValueSol: 0.8,
      takeProfitPct: 50,
      stopLossPct: 20,
    });
    expect(decision).toBe("stop_loss");
  });

  it("matches the exact example from the user: buy at 10,000, sell at 15,000 (+50%)", () => {
    const decision = decideTrigger({
      entrySolAmount: 10_000,
      currentValueSol: 15_000,
      takeProfitPct: 50,
      stopLossPct: null,
    });
    expect(decision).toBe("take_profit");
  });

  it("does not trigger take-profit just below the target", () => {
    const decision = decideTrigger({
      entrySolAmount: 10_000,
      currentValueSol: 14_999,
      takeProfitPct: 50,
      stopLossPct: null,
    });
    expect(decision).toBe("hold");
  });

  it("prioritizes take-profit over stop-loss if somehow both conditions are met", () => {
    // Contrived: TP target below current floor, both technically satisfied
    const decision = decideTrigger({
      entrySolAmount: 1,
      currentValueSol: 1.5,
      takeProfitPct: 10, // target 1.1, met
      stopLossPct: -1000, // nonsensical, but ensures TP is checked first
    });
    expect(decision).toBe("take_profit");
  });

  it("ignores an unset take-profit (null) and only checks stop-loss", () => {
    const decision = decideTrigger({
      entrySolAmount: 1,
      currentValueSol: 0.5,
      takeProfitPct: null,
      stopLossPct: 20,
    });
    expect(decision).toBe("stop_loss");
  });

  it("holds when neither TP nor SL is configured", () => {
    const decision = decideTrigger({
      entrySolAmount: 1,
      currentValueSol: 5,
      takeProfitPct: null,
      stopLossPct: null,
    });
    expect(decision).toBe("hold");
  });
});
