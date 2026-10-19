/** Validate locked graph data before it can address any store/project paths. */
import { isCanonicalStrongSri } from "../util/integrity.ts";
import { valid } from "semver";
import { ZyrkError } from "../errors.ts";
import type { NpmLockDoc } from "../lockfile/types.ts";
import {
  ZYRK_LOCK_EXTENSION_VERSION,
  ZYRK_RESOLVER_POLICY,
} from "../lockfile/types.ts";
import type {
  FinalizedGraph,
  ResolvedOccurrence,
} from "../resolve/resolver.ts";
import { sourceIdOf } from "../util/hash.ts";
import { CONTEXT_CANONICALIZATION_VERSION } from "../version.ts";
import { createGraphDoc } from "../store/graph.ts";

export function packageName(name: string): boolean {
  return (
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) &&
    !["node_modules", "__proto__", "constructor", "prototype"].includes(name) &&
    name.length <= 214
  );
}
export function cleanUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export function lockMismatch(why: string): ZyrkError {
  return new ZyrkError(
    "ZYRK_LOCK_MISMATCH",
    `cannot install the locked graph (${why}).`,
    {
      remedy:
        "Restore a compatible package-lock.json, or refresh it intentionally with zyrk install after reviewing dependency changes.",
    },
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function lockedGraph(doc: NpmLockDoc): FinalizedGraph {
  const ext = doc.zyrk;
  if (
    !ext ||
    ext.version !== ZYRK_LOCK_EXTENSION_VERSION ||
    Object.keys(ext).some(
      (key) =>
        ![
          "version",
          "resolver",
          "platformPolicy",
          "contextCanonicalization",
          "manifest",
          "scripts",
          "config",
          "nodes",
          "roots",
        ].includes(key),
    ) ||
    ![ext.manifest, ext.scripts, ext.config].every(
      (value) =>
        typeof value === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value),
    ) ||
    ext.resolver !== ZYRK_RESOLVER_POLICY ||
    ext.platformPolicy !== "portable-optional/1" ||
    ext.contextCanonicalization !== CONTEXT_CANONICALIZATION_VERSION ||
    !record(ext.nodes) ||
    !record(ext.roots) ||
    Object.keys(ext.roots).length !== 1 ||
    !record(ext.roots["."])
  )
    throw lockMismatch("unsupported graph metadata");
  const nodes: ResolvedOccurrence[] = [];
  for (const [key, raw] of Object.entries(ext.nodes)) {
    if (
      !record(raw) ||
      !key ||
      key.split("/").some((part) => part === ".." || part === ".") ||
      Object.keys(raw).some(
        (field) =>
          ![
            "name",
            "version",
            "integrity",
            "origin",
            "source",
            "tarball",
            "bin",
            "platform",
            "engines",
            "edges",
            "edgeKinds",
            "peers",
            "optionalPeers",
          ].includes(field),
      ) ||
      typeof raw.name !== "string" ||
      !packageName(raw.name) ||
      typeof raw.version !== "string" ||
      valid(raw.version) === null ||
      typeof raw.integrity !== "string" ||
      !isCanonicalStrongSri(raw.integrity) ||
      typeof raw.origin !== "string" ||
      !cleanUrl(raw.origin) ||
      typeof raw.tarball !== "string" ||
      !cleanUrl(raw.tarball) ||
      !record(raw.edges) ||
      !record(raw.edgeKinds) ||
      !record(raw.peers) ||
      !record(raw.bin) ||
      !record(raw.platform)
    )
      throw lockMismatch("invalid node record");
    if (
      Object.keys(raw.edgeKinds).length !== Object.keys(raw.edges).length ||
      Object.keys(raw.edgeKinds).some((name) => !(name in raw.edges))
    )
      throw lockMismatch("edge kind declarations disagree");
    if (
      Object.keys(raw.platform).some(
        (field) => !["os", "cpu", "libc"].includes(field),
      )
    )
      throw lockMismatch("unsupported platform constraints");
    const identity = {
      sourceType: "registry" as const,
      name: raw.name,
      version: raw.version,
      origin: raw.origin,
      integrity: raw.integrity,
    };
    if (sourceIdOf(identity) !== raw.source)
      throw lockMismatch("source identity disagrees with locked inputs");
    const edges: ResolvedOccurrence["edges"] = [];
    for (const [name, target] of Object.entries(raw.edges)) {
      const kind = raw.edgeKinds[name];
      if (
        !packageName(name) ||
        typeof target !== "string" ||
        !["prod", "optional", "peer"].includes(String(kind))
      )
        throw lockMismatch("invalid dependency edge");
      edges.push({
        name,
        target,
        kind: kind as "prod" | "optional" | "peer",
        spec: "",
      });
    }
    for (const [name, kind] of Object.entries(raw.edgeKinds))
      if (kind === "peer" && raw.peers[name] !== raw.edges[name])
        throw lockMismatch("peer edge lacks binding");
    const optionalPeers =
      raw.optionalPeers === undefined ? [] : raw.optionalPeers;
    if (
      !Array.isArray(optionalPeers) ||
      !optionalPeers.every(
        (name: unknown) =>
          typeof name === "string" &&
          packageName(name) &&
          Object.hasOwn(raw.peers, name),
      ) ||
      new Set(optionalPeers).size !== optionalPeers.length
    )
      throw lockMismatch("invalid optional peer declarations");
    const peers: ResolvedOccurrence["peerBindings"] = [];
    for (const [name, target] of Object.entries(raw.peers)) {
      if (
        !packageName(name) ||
        (target !== null && typeof target !== "string") ||
        (target !== null && raw.edges[name] !== target) ||
        (target === null && raw.edges[name] !== undefined)
      )
        throw lockMismatch("invalid peer binding");
      peers.push({
        name,
        target,
        ...(target === null || optionalPeers.includes(name)
          ? { optional: true }
          : {}),
      });
    }
    const bin: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [name, target] of Object.entries(raw.bin)) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ||
        typeof target !== "string" ||
        target.startsWith("/") ||
        target.includes("\\") ||
        target.split("/").some((part) => part === "..") ||
        /^[A-Za-z]:/.test(target)
      )
        throw lockMismatch("invalid binary entry");
      bin[name] = target;
    }
    const platform: ResolvedOccurrence["platform"] = {};
    for (const field of ["os", "cpu", "libc"] as const) {
      const list = raw.platform[field];
      if (list !== undefined) {
        if (
          !Array.isArray(list) ||
          !list.every((item: unknown) => typeof item === "string")
        )
          throw lockMismatch("invalid platform constraints");
        platform[field] = list as string[];
      }
    }
    const engines: Record<string, string> = {};
    if (raw.engines !== undefined) {
      if (!record(raw.engines))
        throw lockMismatch("invalid engine constraints");
      for (const [name, value] of Object.entries(raw.engines)) {
        if (typeof value !== "string")
          throw lockMismatch("invalid engine constraint");
        engines[name] = value;
      }
    }
    nodes.push({
      key,
      ...identity,
      sourceId: raw.source as string,
      tarballUrl: raw.tarball,
      bin,
      ...(raw.engines === undefined ? {} : { engines }),
      platform,
      edges,
      peerBindings: peers,
    });
  }
  const roots = Object.entries(ext.roots["."]).map(([name, target]) => {
    if (
      !packageName(name) ||
      typeof target !== "string" ||
      !nodes.some((node) => node.key === target)
    )
      throw lockMismatch("invalid importer root");
    return { name, target: target as string };
  });
  try {
    createGraphDoc(nodes.map((n) => ({ ...n, deps: n.edges })));
  } catch {
    throw lockMismatch("invalid dependency graph");
  }
  return { nodes, roots };
}

// npm publishes this canonical GitHub sponsorship link in funding metadata.
// Keep source/archive URL validation query-free, and allow no other query here.
function githubFundingUrl(value: string): boolean {
  return (
    /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\?sponsor=1$/.test(
      value,
    ) && new URL(value).href === value
  );
}

/** Preserved metadata is subject to the same portability boundary as new data. */
export function assertPortableLockMetadata(value: unknown, field = ""): void {
  visitPortableLockMetadata(
    value,
    field,
    field === "funding" ? "funding" : undefined,
  );
}
function visitPortableLockMetadata(
  value: unknown,
  field: string,
  funding: "funding" | "entry" | "url" | undefined,
): void {
  if (typeof value === "string") {
    if (
      /^(?:https?:|file:|git\+|ssh:)/i.test(value) &&
      !cleanUrl(value) &&
      !(funding && githubFundingUrl(value))
    )
      throw lockMismatch("portable metadata contains an unsafe URL");
    if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value))
      throw lockMismatch("portable metadata contains a local path");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      visitPortableLockMetadata(
        item,
        field,
        funding === "funding" ? "entry" : undefined,
      );
    return;
  }
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (
        /auth|password|token|secret|credential/i.test(key) &&
        ![
          "packages",
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
          "peerDependenciesMeta",
          "nodes",
          "edges",
          "edgeKinds",
          "peers",
          "bin",
          "roots",
          ".",
        ].includes(field)
      )
        throw lockMismatch("portable metadata contains a credential field");
      visitPortableLockMetadata(
        item,
        key,
        key === "funding"
          ? "funding"
          : (funding === "funding" || funding === "entry") && key === "url"
            ? "url"
            : undefined,
      );
    }
}
