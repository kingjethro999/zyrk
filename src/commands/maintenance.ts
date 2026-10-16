/** Read-only advisory reporting and verified source prefetch. */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { json as fetchJson } from "npm-registry-fetch";
import { satisfies, validRange } from "semver";
import { ZyrkError } from "../errors.ts";
import type { RegistryClient } from "../fetch/registry.ts";
import type { Store } from "../store/layout.ts";
import { installProject, type InstallResult } from "../install/run.ts";
import { readLockfile, assertFrozenCompatible } from "../lockfile/read.ts";
import {
  manifestFingerprint,
  configFingerprint,
  scriptPolicyFingerprint,
} from "../lockfile/fingerprints.ts";
import { lockedGraph, lockMismatch } from "../install/lock.ts";

const severities = ["info", "low", "moderate", "high", "critical"] as const;
type Severity = (typeof severities)[number];
export type AuditResult = {
  kind: "audit";
  status: "complete" | "disabled" | "unavailable";
  advisories: Array<{
    name: string;
    version: string;
    severity: Severity;
    title: string;
    url: string;
  }>;
  thresholdExceeded: boolean;
  warnings: string[];
};
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function usage(reason: string): ZyrkError {
  return new ZyrkError("ZYRK_USAGE", `Cannot run maintenance: ${reason}.`, {
    remedy:
      "Use audit [--audit-level <severity>] [--offline], or fetch --frozen-lockfile [--offline].",
  });
}
export async function runMaintenanceCommand(options: {
  command: "audit" | "fetch" | "repair";
  args: readonly string[];
  projectDir: string;
  store: Store;
  registry: RegistryClient;
}): Promise<InstallResult | AuditResult> {
  let frozen = false,
    offline = false;
  let threshold: string | undefined;
  for (let i = 0; i < options.args.length; i++) {
    const arg = options.args[i]!;
    if (arg === "--offline") offline = true;
    else if (arg === "--frozen-lockfile" && options.command === "fetch")
      frozen = true;
    else if (arg === "--audit-level" && options.command === "audit") {
      threshold = options.args[++i];
      if (threshold === undefined)
        throw usage("--audit-level requires a severity");
    } else if (arg.startsWith("--audit-level=") && options.command === "audit")
      threshold = arg.slice(14);
    else throw usage("an unsupported option or argument was supplied");
  }
  if (options.command === "repair")
    throw new ZyrkError(
      "ZYRK_STORE_CORRUPT",
      "Cannot repair shared content in place while other projects may reference it.",
      {
        remedy:
          "Use store verify to identify affected sources; immutable replacement and reverse-closure repair are not available yet.",
      },
    );
  if (options.command === "fetch") {
    if (!frozen) throw usage("fetch requires --frozen-lockfile");
    return installProject({
      projectDir: options.projectDir,
      store: options.store,
      registry: options.registry,
      frozen: true,
      offline,
      fetchOnly: true,
    });
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(path.join(options.projectDir, "package.json"), "utf8"),
    );
  } catch {
    throw new ZyrkError(
      "ZYRK_MANIFEST_INVALID",
      "Cannot audit dependencies without a readable package.json.",
      { remedy: "Restore the project manifest and retry." },
    );
  }
  if (!object(manifest)) throw usage("package.json must be an object");
  const config = object(manifest.zyrk) ? manifest.zyrk.audit : undefined;
  if (
    config !== undefined &&
    (!object(config) ||
      Object.keys(config).some((key) => !["enabled", "failOn"].includes(key)) ||
      (config.enabled !== undefined && typeof config.enabled !== "boolean") ||
      (config.failOn !== undefined && typeof config.failOn !== "string"))
  )
    throw new ZyrkError(
      "ZYRK_POLICY_DENIED",
      "Cannot audit dependencies with unsupported audit policy settings.",
      {
        remedy:
          "Set package.json zyrk.audit to enabled (boolean) and failOn (none, info, low, moderate, high, or critical).",
      },
    );
  const policy = object(config) ? config : {};
  threshold ??= typeof policy.failOn === "string" ? policy.failOn : "none";
  if (threshold !== "none" && !severities.includes(threshold as Severity))
    throw usage("audit severity threshold is invalid");
  const base: AuditResult = {
    kind: "audit",
    status: "complete",
    advisories: [],
    thresholdExceeded: false,
    warnings: [],
  };
  if (policy.enabled === false)
    return {
      ...base,
      status: "disabled",
      warnings: [
        "Audit is disabled by project policy; no dependency information was sent.",
      ],
    };
  if (offline)
    return {
      ...base,
      status: "unavailable",
      warnings: [
        "Offline audit has no cached advisory data; vulnerability status is unknown.",
      ],
    };
  const lock = await readLockfile(
    path.join(options.projectDir, "package-lock.json"),
  );
  if (!lock?.doc.zyrk)
    throw lockMismatch("audit requires an exact zyrk lockfile");
  assertFrozenCompatible(lock.doc, {
    manifest: manifestFingerprint(manifest),
    scripts: scriptPolicyFingerprint(
      object(manifest.zyrk) ? manifest.zyrk.scripts : undefined,
    ),
    config: configFingerprint({
      registry: options.registry.origin,
      linker: "shared",
    }),
  });
  const graph = lockedGraph(lock.doc);
  const packages: Record<string, string[]> = Object.create(null) as Record<
    string,
    string[]
  >;
  for (const node of graph.nodes) {
    if (node.origin !== options.registry.origin)
      throw new ZyrkError(
        "ZYRK_POLICY_DENIED",
        "Cannot audit a graph from a different registry origin.",
        {
          remedy:
            "Select the registry recorded by the lockfile before sending dependency names.",
        },
      );
    packages[node.name] ??= [];
    if (!packages[node.name]!.includes(node.version))
      packages[node.name]!.push(node.version);
  }
  if (!graph.nodes.length) return base;
  let response: unknown;
  try {
    response = await fetchJson(
      new URL("-/npm/v1/security/advisories/bulk", options.registry.registry)
        .href,
      {
        method: "POST",
        body: packages,
        registry: options.registry.registry,
        retry: false,
        timeout: 15_000,
        headers: { "content-type": "application/json" },
      },
    );
  } catch {
    return {
      ...base,
      status: "unavailable",
      warnings: [
        "The configured registry advisory service is unavailable; vulnerability status is unknown.",
      ],
    };
  }
  const unavailable = (): AuditResult => ({
    ...base,
    status: "unavailable",
    warnings: [
      "The configured advisory service returned unsupported data; vulnerability status is unknown.",
    ],
  });
  if (!object(response)) return unavailable();
  for (const [name, entries] of Object.entries(response)) {
    if (!Object.hasOwn(packages, name) || !Array.isArray(entries))
      return unavailable();
    for (const entry of entries) {
      if (
        !object(entry) ||
        typeof entry.severity !== "string" ||
        !severities.includes(entry.severity as Severity) ||
        typeof entry.vulnerable_versions !== "string" ||
        validRange(entry.vulnerable_versions) === null ||
        typeof entry.title !== "string" ||
        typeof entry.url !== "string"
      )
        return unavailable();
      let url: URL;
      try {
        url = new URL(entry.url);
      } catch {
        return unavailable();
      }
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return unavailable();
      for (const version of packages[name]!)
        if (satisfies(version, entry.vulnerable_versions))
          base.advisories.push({
            name,
            version,
            severity: entry.severity as Severity,
            title: entry.title
              .replace(/[\u0000-\u001f\u007f]/g, " ")
              .slice(0, 500),
            url: url.href,
          });
    }
  }
  base.advisories.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version) ||
      a.title.localeCompare(b.title),
  );
  base.thresholdExceeded =
    threshold !== "none" &&
    base.advisories.some(
      (advisory) =>
        severities.indexOf(advisory.severity) >=
        severities.indexOf(threshold as Severity),
    );
  return base;
}
