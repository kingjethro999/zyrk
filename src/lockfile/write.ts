/**
 * package-lock.json writer: refresh npm-owned selections, record the zyrk
 * extension, preserve everything else byte-identically (D-1).
 *
 * npm `packages` entries are maintained only for the root importer and its
 * direct dependencies (the links a project projection actually creates);
 * the transitive closure lives in the zyrk extension. Existing npm entries
 * — including transitive ones from an npm-written lock — are preserved as
 * found and never deleted: the writer updates what it owns and leaves the
 * rest alone. Same inputs always produce byte-identical output.
 */

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
  for (const location of Object.keys(existingPackages).sort()) {
    const entry = existingPackages[location];
    if (entry !== undefined) packages[location] = { ...entry };
  }
  packages[""] = {
    ...(packages[""] ?? {}),
    name: options.name,
    version: options.version,
    dependencies: { ...options.manifestDeps },
  };
  for (const root of [...options.resolution.roots].sort((a, b) =>
    compareStrings(a.name, b.name),
  )) {
    const node = byKey.get(root.target);
    if (node === undefined) {
      throw new ZyrkError(
        "ZYRK_INTERNAL",
        `resolution root ${root.name} has no node`,
        {
          detail: { root: root.name, target: root.target },
        },
      );
    }
    const location = `node_modules/${root.name}`;
    packages[location] = {
      ...(packages[location] ?? {}),
      version: node.version,
      resolved: node.tarballUrl,
      integrity: node.integrity,
    };
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
      edges,
      edgeKinds,
      peers,
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
    ...(existing.dependencies === undefined
      ? {}
      : { dependencies: existing.dependencies }),
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

  await writeFileAtomic(options.path, `${JSON.stringify(doc, null, 2)}\n`, {
    mode: 0o644,
  });
  return doc;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
