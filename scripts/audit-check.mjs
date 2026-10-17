#!/usr/bin/env node
/** An unavailable audit service must never be reported as a clean audit. */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const severities = ["info", "low", "moderate", "high", "critical"];

/** Classify npm's JSON without emitting its potentially sensitive raw output. */
export function classifyAudit(result) {
  const unavailable = { kind: "unavailable", exitCode: 2 };
  if (result.error || result.signal || !Number.isInteger(result.status))
    return unavailable;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return unavailable;
  }
  if (
    report === null ||
    typeof report !== "object" ||
    report.auditReportVersion !== 2 ||
    "error" in report ||
    report.vulnerabilities === null ||
    typeof report.vulnerabilities !== "object" ||
    Array.isArray(report.vulnerabilities)
  )
    return unavailable;
  const counts = report.metadata?.vulnerabilities;
  if (
    counts === null ||
    typeof counts !== "object" ||
    ![...severities, "total"].every(
      (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0,
    ) ||
    severities.reduce((sum, key) => sum + counts[key], 0) !== counts.total
  )
    return unavailable;
  if (result.status !== 0 && result.status !== 1) return unavailable;
  if (counts.total > 0)
    return { kind: "vulnerabilities", exitCode: 1, total: counts.total };
  if (result.status !== 0 || Object.keys(report.vulnerabilities).length !== 0)
    return unavailable;
  return { kind: "clean", exitCode: 0, total: 0 };
}

export function runAudit() {
  const result = spawnSync("npm", ["audit", "--json", "--audit-level=low"], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const outcome = classifyAudit(result);
  if (outcome.kind === "clean")
    console.log(
      "Dependency audit completed: no known vulnerabilities reported.",
    );
  else if (outcome.kind === "vulnerabilities")
    console.error(
      `Dependency audit completed: ${outcome.total} known vulnerabilities reported. Run npm audit locally to review affected packages.`,
    );
  else
    console.error(
      "Dependency audit unavailable: npm failed, timed out, or returned an invalid report. This is not a clean audit; inspect registry availability and retry.",
    );
  return outcome.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = runAudit();
