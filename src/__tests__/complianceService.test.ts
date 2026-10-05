jest.mock("../db/supabase", () => {
  const state: Record<string, { terms_accepted_at: string | null }> = {};
  return {
    __state: state,
    supabase: {
      from: (_table: string) => ({
        select: () => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: async () => ({
              data: state[val] ? { terms_accepted_at: state[val].terms_accepted_at } : null,
            }),
          }),
        }),
        update: (fields: any) => ({
          eq: async (_col: string, val: string) => {
            state[val] = { terms_accepted_at: fields.terms_accepted_at };
            return { error: null };
          },
        }),
      }),
    },
  };
});

import { hasAcceptedTerms, acceptTerms, requireAcceptedTerms } from "../services/complianceService";

describe("complianceService", () => {
  it("reports terms not accepted for a brand-new user", async () => {
    expect(await hasAcceptedTerms("user-1")).toBe(false);
  });

  it("blocks trading with a message until terms are accepted", async () => {
    const gate = await requireAcceptedTerms("user-2");
    expect(gate.accepted).toBe(false);
    if (!gate.accepted) {
      expect(gate.message).toMatch(/\/accept/);
    }
  });

  it("allows trading after acceptTerms is called", async () => {
    await acceptTerms("user-3");
    expect(await hasAcceptedTerms("user-3")).toBe(true);

    const gate = await requireAcceptedTerms("user-3");
    expect(gate.accepted).toBe(true);
  });
});
