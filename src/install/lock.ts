/** Validate locked graph data before it can address any store/project paths. */
import { valid } from "semver";
import { ZyrkError } from "../errors.ts";
import type { NpmLockDoc } from "../lockfile/types.ts";
import { ZYRK_RESOLVER_POLICY } from "../lockfile/types.ts";
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
    ext.resolver !== ZYRK_RESOLVER_POLICY ||
    ext.contextCanonicalization !== CONTEXT_CANONICALIZATION_VERSION ||
    !record(ext.nodes) ||
    !record(ext.roots) ||
    !record(ext.roots["."])
  )
    throw lockMismatch("unsupported graph metadata");
  const nodes: ResolvedOccurrence[] = [];
  for (const [key, raw] of Object.entries(ext.nodes)) {
    if (
      !record(raw) ||
      typeof raw.name !== "string" ||
      !packageName(raw.name) ||
      typeof raw.version !== "string" ||
      valid(raw.version) === null ||
      typeof raw.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(raw.integrity) ||
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
    const peers: ResolvedOccurrence["peerBindings"] = [];
    for (const [name, target] of Object.entries(raw.peers)) {
      if (
        !packageName(name) ||
        (target !== null && typeof target !== "string") ||
        (target !== null && raw.edges[name] !== target)
      )
        throw lockMismatch("invalid peer binding");
      peers.push({ name, target });
    }
    const bin: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [name, target] of Object.entries(raw.bin)) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ||
        typeof target !== "string"
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
      engines,
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
