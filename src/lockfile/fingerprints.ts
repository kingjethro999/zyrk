/**
 * Lockfile fingerprints: short SRI digests over canonical JSON describing
 * exactly what a frozen install must re-verify (SPEC 14.2).
 *
 * - manifest: importer dependency declarations (prod/dev/optional/peer
 *   groups, overrides, workspace membership). Any requirement change alters
 *   the allowed set, so the frozen lock must be refreshed intentionally.
 * - scripts: the portable project script policy (D-2 `zyrk.scripts`
 *   field, or the documented default). Local trust changes live outside
 *   the lock; only portable intent is fingerprinted.
 * - config: resolution-affecting configuration (registry origin, linker
 *   mode). Secrets never participate.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../util/json.ts";

function fingerprintOf(value: unknown): string {
  return `sha512-${createHash("sha512").update(canonicalJson(value), "utf8").digest("base64")}`;
}

export type ManifestDeclaration = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  overrides?: unknown;
  workspaces?: unknown;
};

/** npm evaluates sibling override rules in declaration order. Preserve that
 * order inside canonical JSON instead of sorting the policy's object keys. */
function orderedOverridePolicy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedOverridePolicy);
  if (value && typeof value === "object")
    return Object.entries(value).map(([key, rule]) => [
      key,
      orderedOverridePolicy(rule),
    ]);
  return value;
}

export function manifestFingerprint(manifest: ManifestDeclaration): string {
  const normalized: Record<string, Record<string, string> | undefined> = {};
  for (const group of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const entries = manifest[group];
    if (entries === undefined) continue;
    const sorted: Record<string, string> = {};
    for (const name of Object.keys(entries).sort()) {
      const spec = entries[name];
      if (typeof spec === "string") sorted[name] = spec;
    }
    normalized[group] = sorted;
  }
  return fingerprintOf({
    groups: normalized,
    peerDependenciesMeta: manifest.peerDependenciesMeta ?? {},
    ...(manifest.overrides === undefined
      ? {}
      : { overrides: orderedOverridePolicy(manifest.overrides) }),
    ...(manifest.workspaces === undefined
      ? {}
      : { workspaces: manifest.workspaces }),
  });
}

export const DEFAULT_SCRIPT_POLICY = { default: "deny", allow: [], deny: [] };

export function scriptPolicyFingerprint(policy: unknown): string {
  if (policy === undefined) return fingerprintOf(DEFAULT_SCRIPT_POLICY);
  return fingerprintOf(policy);
}

export type ResolutionConfig = {
  /** Credential-free registry origin. */
  registry: string;
  registries?: Readonly<Record<string, string>>;
  linker: "shared" | "local";
  patches?: string;
  mutablePackages?: readonly string[];
  platform?: { os: string; cpu: string; libc?: string };
};

export function configFingerprint(config: ResolutionConfig): string {
  return fingerprintOf({
    registry: config.registry,
    ...(config.registries && Object.keys(config.registries).length
      ? { registries: config.registries }
      : {}),
    linker: config.linker,
    ...(config.patches === undefined ? {} : { patches: config.patches }),
    ...(config.platform === undefined ? {} : { platform: config.platform }),
    ...(config.mutablePackages === undefined
      ? {}
      : { mutablePackages: [...config.mutablePackages].sort() }),
  });
}
