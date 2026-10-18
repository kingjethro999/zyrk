import { expect, it } from "vitest";
import { installBudgets } from "../src/install/budgets.ts";

it("provides bounded default install timeouts without changing graph or byte limits", () => {
  expect(installBudgets({})).toEqual({
    resolveBudget: { deadlineMs: 300000 },
    extractBudget: { maxDurationMs: 120000 },
  });
});
it("accepts public integer timeout overrides", () => {
  expect(
    installBudgets({
      ZYRK_RESOLVE_TIMEOUT_MS: "900000",
      ZYRK_EXTRACT_TIMEOUT_MS: "1",
    }),
  ).toEqual({
    resolveBudget: { deadlineMs: 900000 },
    extractBudget: { maxDurationMs: 1 },
  });
});
it.each([
  "",
  "0",
  "-1",
  "1.5",
  "Infinity",
  "NaN",
  "900001",
  "1e3",
  " 1000",
  "1000x",
])("rejects invalid public timeout %j without echoing it", (value) => {
  for (const key of ["ZYRK_RESOLVE_TIMEOUT_MS", "ZYRK_EXTRACT_TIMEOUT_MS"]) {
    expect(() => installBudgets({ [key]: value })).toThrow(
      /integer from 1 to 900000/,
    );
  }
});
