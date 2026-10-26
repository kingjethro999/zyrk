/** Write both complete npm selections and the validated zyrk graph atomically.
 * Stale npm package entries are removed; portable unrelated root metadata stays.
 */

import { validateLockDoc } from "./read.ts";
import { assertPortableLockMetadata, lockMismatch } from "../install/lock.ts";
import { ZyrkError } from "../errors.ts";
import type { ResolvedOccurrence } from "../resolve/resolver.ts";
import { CONTEXT_CANONICALIZATION_VERSION } from "../version.ts";
import { writeFileAtomic } from "../util/fsx.ts";
import {
  ZYRK_LOCK_EXTENSION_VERSION,
  ZYRK_RESOLVER_POLICY,
  type NpmLockDoc,
  type ZyrkLockExtension,
  type ZyrkLockNode,
} from "./types.ts";

export type WriteLockResolution = {
  nodes: ResolvedOccurrence[];
  roots: Array<{ name: string; target: string }>;
};

export type WriteLockOptions = {
  path: string;
  /** Project identity for the root importer entry. */
  name: string;
  version: string;
  /** Declared direct dependencies for npm's root `dependencies` map. */
  manifestDeps: Record<string, string>;
  manifestDevDeps?: Record<string, string>;
  manifestOptionalDeps?: Record<string, string>;
  manifestPeerDeps?: Record<string, string>;
  manifestPeerMeta?: Record<string, { optional?: boolean }>;
  existing?: NpmLockDoc | null;
  resolution: WriteLockResolution;
  fingerprints: { manifest: string; scripts: string; config: string };
  lockfileVersion?: 2 | 3;
};

export async function writeLockfile(
  options: WriteLockOptions,
): Promise<NpmLockDoc> {
  const existing: NpmLockDoc =
    options.existing === undefined || options.existing === null
      ? {}
      : (JSON.parse(JSON.stringify(options.existing)) as NpmLockDoc);
  if (existing.lockfileVersion === 1) {
    throw new ZyrkError(
      "ZYRK_MANIFEST_INVALID",
      "existing lockfile uses the legacy v1 layout, which zyrk cannot refresh",
      {
        detail: { path: options.path },
        remedy:
          "regenerate the lockfile with a modern npm (lockfileVersion 2 or 3) first",
      },
    );
  }
  const lockfileVersion =
    options.lockfileVersion ?? existing.lockfileVersion ?? 3;
  if (lockfileVersion !== 2 && lockfileVersion !== 3) {
    throw new ZyrkError(
      "ZYRK_INTERNAL",
      `unsupported lockfileVersion ${lockfileVersion}`,
      {
        detail: { path: options.path },
      },
    );
  }

  const byKey = new Map(
    options.resolution.nodes.map((node) => [node.key, node]),
  );

  const packages: Record<string, Record<string, unknown>> = {};
  const existingPackages = existing.packages ?? {};
  packages[""] = {
    ...(existingPackages[""] ?? {}),
    name: options.name,
    version: options.version,
    dependencies: { ...options.manifestDeps },
    devDependencies: options.manifestDevDeps ?? {},
    optionalDependencies: options.manifestOptionalDeps ?? {},
    peerDependencies: options.manifestPeerDeps ?? {},
    peerDependenciesMeta: options.manifestPeerMeta ?? {},
  };
  const placements = new Map<string, string>();
  const lookup = (location: string, name: string): string | undefined => {
    let current = location;
    for (;;) {
      const candidate = `${current ? `${current}/` : ""}node_modules/${name}`;
      if (placements.has(candidate)) return candidate;
      if (!current) return undefined;
      current = current.slice(
        0,
        Math.max(0, current.lastIndexOf("/node_modules/")),
      );
    }
  };
  const populate = (location: string, key: string): void => {
    const placed = placements.get(location);
    if (placed !== undefined) {
      if (placed !== key)
        throw lockMismatch(
          "npm layout cannot represent conflicting peer bindings",
        );
      return;
    }
    const node = byKey.get(key);
    if (!node) throw lockMismatch("resolution references a missing node");
    placements.set(location, key);
    const dependencies: Record<string, string> = {};
    const optionalDependencies: Record<string, string> = {};
    const peerDependencies: Record<string, string> = {};
    const peerDependenciesMeta: Record<string, { optional: true }> = {};
    for (const edge of node.edges) {
      const child = byKey.get(edge.target);
      if (!child)
        throw lockMismatch("resolution references a missing dependency");
      const entries =
        edge.kind === "peer"
          ? peerDependencies
          : edge.kind === "optional"
            ? optionalDependencies
            : dependencies;
      entries[edge.name] =
        child.name === edge.name
          ? child.version
          : `npm:${child.name}@${child.version}`;
    }
    for (const peer of node.peerBindings) {
      if (peer.optional) peerDependenciesMeta[peer.name] = { optional: true };
      if (peer.target === null) {
        peerDependencies[peer.name] = "*";
        peerDependenciesMeta[peer.name] = { optional: true };
      } else {
        const target = byKey.get(peer.target);
        if (!target)
          throw lockMismatch("peer binding references a missing node");
        peerDependencies[peer.name] =
          target.name === peer.name
            ? target.version
            : `npm:${target.name}@${target.version}`;
      }
    }
    const npmMetadata: Record<string, unknown> = {};
    const existingEntry = existingPackages[location];
    if (existingEntry !== undefined) {
      for (const field of [
        "license",
        "funding",
        "deprecated",
        "hasInstallScript",
        "inBundle",
      ]) {
        if (Object.hasOwn(existingEntry, field)) {
          npmMetadata[field] = existingEntry[field];
        }
      }
    }
    packages[location] = {
      ...npmMetadata,
      name: node.name,
      version: node.version,
      resolved: node.tarballUrl,
      integrity: node.integrity,
      dependencies,
      optionalDependencies,
      peerDependencies,
      peerDependenciesMeta,
      ...(Object.keys(node.bin).length ? { bin: node.bin } : {}),
      ...node.platform,
      ...(node.engines === undefined ? {} : { engines: node.engines }),
    };
    // Establish peers before descending into ordinary children. A peer must be
    // visible beside or above its consumer; its own node_modules is invalid to
    // npm even if that directory already contains the requested version.
    const placementEdges = [...node.edges].sort(
      (a, b) => Number(b.kind === "peer") - Number(a.kind === "peer"),
    );
    for (const edge of placementEdges) {
      const base =
        edge.kind === "peer"
          ? location.slice(
              0,
              Math.max(0, location.lastIndexOf("/node_modules/")),
            )
          : location;
      const found = lookup(base, edge.name);
      if (found !== undefined && placements.get(found) === edge.target)
        continue;
      if (edge.kind === "peer") {
        populate(
          `${base ? `${base}/` : ""}node_modules/${edge.name}`,
          edge.target,
        );
      } else {
        populate(`${location}/node_modules/${edge.name}`, edge.target);
      }
    }
  };
  // Reserve root slots before walking so cycles and peers resolve through them.
  for (const root of options.resolution.roots)
    placements.set(`node_modules/${root.name}`, root.target);
  for (const root of options.resolution.roots) {
    const location = `node_modules/${root.name}`;
    placements.delete(location);
    populate(location, root.target);
  }
  const sortedPackages: Record<string, Record<string, unknown>> = {};
  for (const location of Object.keys(packages).sort()) {
    const entry = packages[location];
    if (entry !== undefined) sortedPackages[location] = entry;
  }

  const nodes: Record<string, ZyrkLockNode> = {};
  for (const node of [...options.resolution.nodes].sort((a, b) =>
    compareStrings(a.key, b.key),
  )) {
    const edges: Record<string, string> = {};
    const edgeKinds: Record<string, "prod" | "optional" | "peer"> = {};
    for (const edge of [...node.edges].sort((a, b) =>
      compareStrings(a.name, b.name),
    )) {
      edges[edge.name] = edge.target;
      edgeKinds[edge.name] = edge.kind;
    }
    const peers: Record<string, string | null> = {};
    for (const binding of [...node.peerBindings].sort((a, b) =>
      compareStrings(a.name, b.name),
    )) {
      peers[binding.name] = binding.target;
    }
    nodes[node.key] = {
      name: node.name,
      version: node.version,
      integrity: node.integrity,
      origin: node.origin,
      source: node.sourceId,
      tarball: node.tarballUrl,
      bin: node.bin,
      platform: node.platform,
      ...(node.engines === undefined ? {} : { engines: node.engines }),
      edges,
      edgeKinds,
      peers,
      optionalPeers: node.peerBindings
        .filter((binding) => binding.optional || binding.target === null)
        .map((binding) => binding.name)
        .sort(),
    };
  }
  const rootMap: Record<string, string> = {};
  for (const root of [...options.resolution.roots].sort((a, b) =>
    compareStrings(a.name, b.name),
  )) {
    rootMap[root.name] = root.target;
  }
  const extension: ZyrkLockExtension = {
    version: ZYRK_LOCK_EXTENSION_VERSION,
    resolver: ZYRK_RESOLVER_POLICY,
    platformPolicy: "portable-optional/1",
    contextCanonicalization: CONTEXT_CANONICALIZATION_VERSION,
    manifest: options.fingerprints.manifest,
    scripts: options.fingerprints.scripts,
    config: options.fingerprints.config,
    nodes,
    roots: { ".": rootMap },
  };

  const doc: NpmLockDoc = {
    name: options.name,
    version: options.version,
    lockfileVersion,
    requires: existing.requires ?? true,
    packages: sortedPackages,
  };
  for (const key of Object.keys(existing)) {
    if (
      key === "name" ||
      key === "version" ||
      key === "lockfileVersion" ||
      key === "requires" ||
      key === "packages" ||
      key === "dependencies" ||
      key === "zyrk"
    ) {
      continue;
    }
    doc[key] = existing[key];
  }
  doc.zyrk = extension;

  assertPortableLockMetadata(doc);
  validateLockDoc(doc, "package-lock.json");
  await writeFileAtomic(options.path, `${JSON.stringify(doc, null, 2)}\n`, {
    mode: 0o644,
  });
  return doc;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
