import { describe, expect, it } from "vitest";
import { classifyAudit } from "../scripts/audit-check.mjs";

const report = (total = 0): string =>
  JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: total ? { fixture: { severity: "high" } } : {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: total,
        critical: 0,
        total,
      },
    },
  });

describe("dependency audit result classification", () => {
  it("accepts only a successful complete clean report", () => {
    expect(classifyAudit({ status: 0, stdout: report() })).toEqual({
      kind: "clean",
      exitCode: 0,
      total: 0,
    });
  });
  it.each([0, 1])(
    "reports vulnerabilities independently of npm exit %s",
    (status) => {
      expect(classifyAudit({ status, stdout: report(2) })).toEqual({
        kind: "vulnerabilities",
        exitCode: 1,
        total: 2,
      });
    },
  );
  it.each([
    { status: 1, stdout: report() },
    { status: 2, stdout: report() },
    { status: 0, stdout: "{}" },
    { status: 0, stdout: "not json" },
    {
      status: 1,
      stdout: JSON.stringify({
        error: { code: "ENOAUDIT", summary: "service unavailable" },
      }),
    },
    { status: 0, stdout: report(), error: new Error("timeout") },
    { status: null, signal: "SIGTERM", stdout: report() },
    { status: 0, stdout: report().replace('"total":0', '"total":-1') },
    { status: 0, stdout: report().replace('"high":0', '"high":1') },
    {
      status: 0,
      stdout: report().replace(
        '"vulnerabilities":{}',
        '"vulnerabilities":{"unexpected":{}}',
      ),
    },
  ])(
    "distinguishes unavailable or inconsistent output from clean",
    (result) => {
      expect(classifyAudit(result)).toEqual({
        kind: "unavailable",
        exitCode: 2,
      });
    },
  );
});
