import { expect, it } from "vitest";
import {
  installBudgets,
  registryRequestDeadline,
} from "../src/install/budgets.ts";

it("provides bounded default install timeouts without changing graph or byte limits", () => {
  expect(installBudgets({})).toEqual({
    resolveBudget: { deadlineMs: 300000 },
    extractBudget: { maxDurationMs: 120000 },
    fetchBudget: { deadlineMs: 900000 },
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
    fetchBudget: { deadlineMs: 900000 },
  });
});
it("provides a separately bounded registry request timeout", () => {
  expect(registryRequestDeadline({})).toBe(900000);
  expect(registryRequestDeadline({ ZYRK_REQUEST_TIMEOUT_MS: "1234" })).toBe(
    1234,
  );
  expect(registryRequestDeadline({ ZYRK_REQUEST_TIMEOUT_MS: "3600000" })).toBe(
    3600000,
  );
  expect(() =>
    registryRequestDeadline({ ZYRK_REQUEST_TIMEOUT_MS: "3600001" }),
  ).toThrow(/ZYRK_REQUEST_TIMEOUT_MS/);
});
it("allows a bounded whole-fetch timeout for slow networks", () => {
  expect(
    installBudgets({ ZYRK_FETCH_TIMEOUT_MS: "2700000" }).fetchBudget,
  ).toEqual({
    deadlineMs: 2700000,
  });
  expect(() => installBudgets({ ZYRK_FETCH_TIMEOUT_MS: "3600001" })).toThrow(
    /ZYRK_FETCH_TIMEOUT_MS/,
  );
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
      /integer from 1 to (900000|3600000)/,
    );
  }
  expect(() => installBudgets({ ZYRK_FETCH_TIMEOUT_MS: "3600001" })).toThrow(
    /integer from 1 to 3600000/,
  );
});
