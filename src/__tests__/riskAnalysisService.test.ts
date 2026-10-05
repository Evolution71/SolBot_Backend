import { scoreRiskFactors, riskLevelRank } from "../services/riskAnalysisService";

describe("scoreRiskFactors", () => {
  it("scores a fully clean token as low risk", () => {
    const result = scoreRiskFactors({
      mintAuthorityRenounced: true,
      freezeAuthorityRenounced: true,
      topHolderConcentrationPct: 20,
      priceImpactAt1SolPct: 1,
    });
    expect(result.level).toBe("low");
  });

  it("flags an active mint authority as a major red flag", () => {
    const result = scoreRiskFactors({
      mintAuthorityRenounced: false,
      freezeAuthorityRenounced: true,
      topHolderConcentrationPct: 20,
      priceImpactAt1SolPct: 1,
    });
    expect(result.level).not.toBe("low");
    expect(result.reasons.some((r) => r.includes("Mint authority"))).toBe(true);
  });

  it("scores extreme holder concentration plus thin liquidity as high risk", () => {
    const result = scoreRiskFactors({
      mintAuthorityRenounced: true,
      freezeAuthorityRenounced: true,
      topHolderConcentrationPct: 90,
      priceImpactAt1SolPct: 20,
    });
    expect(result.level).toBe("high");
  });

  it("treats unknown/unverifiable factors as mildly risky, not safe", () => {
    const result = scoreRiskFactors({
      mintAuthorityRenounced: null,
      freezeAuthorityRenounced: null,
      topHolderConcentrationPct: null,
      priceImpactAt1SolPct: null,
    });
    expect(result.score).toBeGreaterThan(0);
  });

  it("caps the score at 100 even with every red flag present", () => {
    const result = scoreRiskFactors({
      mintAuthorityRenounced: false,
      freezeAuthorityRenounced: false,
      topHolderConcentrationPct: 99,
      priceImpactAt1SolPct: 50,
    });
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.level).toBe("high");
  });
});

describe("riskLevelRank", () => {
  it("orders low < medium < high", () => {
    expect(riskLevelRank("low")).toBeLessThan(riskLevelRank("medium"));
    expect(riskLevelRank("medium")).toBeLessThan(riskLevelRank("high"));
  });
});
