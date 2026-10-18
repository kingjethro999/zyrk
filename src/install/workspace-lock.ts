/** Portable multi-importer lock. Live directories carry importer IDs, never CAS identities. */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { valid } from "semver";
import type { NpmLockDoc } from "../lockfile/types.ts";
import { CONTEXT_CANONICALIZATION_VERSION } from "../version.ts";
import { ZYRK_RESOLVER_POLICY } from "../lockfile/types.ts";
import {
  assertPortableLockMetadata,
  lockedGraph,
  lockMismatch,
  packageName,
} from "./lock.ts";
import type { WorkspaceGraph, WorkspaceNode } from "./workspace-graph.ts";
import type { WorkspaceProject } from "./workspaces.ts";
import { canonicalJson } from "../util/json.ts";
import { isErrno } from "../util/fsx.ts";
export type WorkspaceFingerprints = {
  manifest: string;
  scripts: string;
  config: string;
};
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function safeImporter(id: unknown): id is string {
  return (
    typeof id === "string" &&
    (id === "." ||
      (!id.includes("\\") &&
        !id.includes("\0") &&
        !id.startsWith("/") &&
        !/^[A-Za-z]:/.test(id) &&
        id
          .split("/")
          .every(
            (s) =>
              !!s &&
              s !== "." &&
              s !== ".." &&
              s !== "node_modules" &&
              s !== ".zyrk-local" &&
              s !== ".git" &&
              s !== ".zyrk",
          )))
  );
}
export function workspaceLockDoc(
  project: WorkspaceProject,
  graph: WorkspaceGraph,
  fp: WorkspaceFingerprints,
): NpmLockDoc {
  const packages: Record<string, Record<string, unknown>> = {};
  for (const importer of project.importers) {
    const m = importer.manifest;
    packages[importer.id === "." ? "" : importer.id] = {
      name: m.name ?? "workspace-root",
      version: m.version ?? "0.0.0",
      ...Object.fromEntries(
        [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
          "peerDependenciesMeta",
          "workspaces",
        ]
          .filter((k) => m[k] !== undefined)
          .map((k) => [k, m[k]]),
      ),
    };
  }
  populateNpmWorkspacePackages(packages, graph);
  const doc: NpmLockDoc = {
    name:
      project.importers.find((i) => i.id === ".")?.manifest.name ??
      "workspace-root",
    lockfileVersion: 3,
    requires: true,
    packages,
    zyrk: {
      version: 2,
      resolver: ZYRK_RESOLVER_POLICY,
      contextCanonicalization: CONTEXT_CANONICALIZATION_VERSION,
      ...fp,
      nodes: {},
      roots: {},
      workspaceGraph: graph,
    },
  };
  validateWorkspaceLockDoc(doc);
  return doc;
}
export function validateWorkspaceLockDoc(doc: unknown): WorkspaceGraph {
  if (!object(doc) || !object(doc.zyrk))
    throw lockMismatch("missing workspace lock extension");
  const e = doc.zyrk;
  if (
    Object.keys(e).some(
      (k) =>
        ![
          "version",
          "resolver",
          "contextCanonicalization",
          "manifest",
          "scripts",
          "config",
          "nodes",
          "roots",
          "workspaceGraph",
        ].includes(k),
    ) ||
    !object(e.nodes) ||
    Object.keys(e.nodes).length !== 0 ||
    !object(e.roots) ||
    Object.keys(e.roots).length !== 0 ||
    e.version !== 2 ||
    e.resolver !== ZYRK_RESOLVER_POLICY ||
    e.contextCanonicalization !== CONTEXT_CANONICALIZATION_VERSION ||
    typeof e.manifest !== "string" ||
    !/^[a-f0-9]{128}$/.test(e.manifest) ||
    !["scripts", "config"].every(
      (k) =>
        typeof e[k] === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(e[k]),
    ) ||
    !object(e.workspaceGraph)
  )
    throw lockMismatch("invalid workspace extension");

  const g = e.workspaceGraph;
  if (
    Object.keys(g).some(
      (k) => !["nodes", "importers", "omissions"].includes(k),
    ) ||
    !Array.isArray(g.nodes) ||
    g.nodes.length > 10000 ||
    !object(g.importers) ||
    !Array.isArray(g.omissions)
  )
    throw lockMismatch("invalid workspace graph");
  const nodes = new Map<string, WorkspaceNode>();
  for (const raw of g.nodes) {
    if (
      !object(raw) ||
      typeof raw.key !== "string" ||
      !["registry", "local"].includes(String(raw.kind)) ||
      typeof raw.name !== "string" ||
      !packageName(raw.name) ||
      typeof raw.version !== "string" ||
      !valid(raw.version) ||
      !Array.isArray(raw.edges) ||
      !object(raw.peers) ||
      !Array.isArray(raw.optionalPeers) ||
      nodes.has(raw.key) ||
      Object.keys(raw).some(
        (k) =>
          !(
            raw.kind === "local"
              ? [
                  "kind",
                  "key",
                  "name",
                  "version",
                  "importer",
                  "edges",
                  "peers",
                  "optionalPeers",
                ]
              : [
                  "kind",
                  "key",
                  "name",
                  "version",
                  "sourceId",
                  "integrity",
                  "origin",
                  "tarballUrl",
                  "bin",
                  "platform",
                  "engines",
                  "edges",
                  "peers",
                  "optionalPeers",
                ]
          ).includes(k),
      )
    )
      throw lockMismatch("invalid workspace node");
    if (
      raw.kind === "local" &&
      (!safeImporter(raw.importer) ||
        raw.key !== `workspace:${raw.importer}` ||
        raw.sourceId !== undefined)
    )
      throw lockMismatch("invalid live importer");
    const seen = new Set<string>();
    for (const edge of raw.edges) {
      if (
        !object(edge) ||
        Object.keys(edge).some(
          (k) => !["name", "target", "kind", "spec"].includes(k),
        ) ||
        typeof edge.name !== "string" ||
        !packageName(edge.name) ||
        typeof edge.target !== "string" ||
        !["prod", "dev", "optional", "peer"].includes(String(edge.kind)) ||
        typeof edge.spec !== "string" ||
        seen.has(edge.name)
      )
        throw lockMismatch("invalid workspace edge");
      seen.add(edge.name);
    }
    for (const [name, target] of Object.entries(raw.peers))
      if (
        !packageName(name) ||
        (target !== null && typeof target !== "string") ||
        (target !== null &&
          !raw.edges.some(
            (v: unknown) => object(v) && v.name === name && v.target === target,
          ))
      )
        throw lockMismatch("invalid workspace peer");
    if (
      raw.optionalPeers.some(
        (v: unknown) =>
          typeof v !== "string" || !Object.hasOwn(raw.peers as object, v),
      )
    )
      throw lockMismatch("invalid optional workspace peer");
    if (new Set(raw.optionalPeers).size !== raw.optionalPeers.length)
      throw lockMismatch("duplicate optional peer");
    for (const edge of raw.edges)
      if (edge.kind === "peer" && raw.peers[edge.name] !== edge.target)
        throw lockMismatch("unbound workspace peer edge");
    nodes.set(raw.key, raw as unknown as WorkspaceNode);
  }
  for (const node of nodes.values())
    for (const edge of node.edges)
      if (!nodes.has(edge.target))
        throw lockMismatch("missing workspace edge target");
  const locals = [...nodes.values()].filter((n) => n.kind === "local");
  if (
    !Object.hasOwn(g.importers, ".") ||
    Object.keys(g.importers).length !== locals.length
  )
    throw lockMismatch("incomplete workspace importers");
  for (const [id, key] of Object.entries(g.importers)) {
    if (!safeImporter(id) || typeof key !== "string")
      throw lockMismatch("unsafe importer location");
    const node = nodes.get(key);
    if (node?.kind !== "local" || node.importer !== id)
      throw lockMismatch("importer identity disagrees");
  }
  for (const omission of g.omissions)
    if (
      !object(omission) ||
      Object.keys(omission).some(
        (k) => !["name", "parent", "reason"].includes(k),
      ) ||
      typeof omission.name !== "string" ||
      !packageName(omission.name) ||
      typeof omission.parent !== "string" ||
      !nodes.has(omission.parent) ||
      omission.reason !== "platform"
    )
      throw lockMismatch("invalid workspace omission");
  const reachable = new Set<string>(),
    pending = Object.values(g.importers) as string[];
  while (pending.length) {
    const key = pending.pop()!;
    if (reachable.has(key)) continue;
    reachable.add(key);
    for (const edge of nodes.get(key)!.edges) pending.push(edge.target);
  }
  if (reachable.size !== nodes.size)
    throw lockMismatch("unreachable workspace node");
  // Only declared importer-to-importer local protocol references may carry relative paths.
  const portable = structuredClone(doc) as Record<string, unknown>;
  const portableGraph = (portable.zyrk as { workspaceGraph: WorkspaceGraph })
    .workspaceGraph;
  for (const node of portableGraph.nodes)
    for (const edge of node.edges)
      if (edge.spec.startsWith("file:") || edge.spec.startsWith("link:")) {
        const relative = edge.spec.slice(edge.spec.indexOf(":") + 1),
          target = nodes.get(edge.target);
        if (
          node.kind !== "local" ||
          target?.kind !== "local" ||
          !relative ||
          relative.includes("\\") ||
          relative.includes("\0") ||
          relative.startsWith("/") ||
          /^[A-Za-z]:/.test(relative) ||
          path.posix.normalize(
            path.posix.join(
              node.importer === "." ? "" : node.importer,
              relative,
            ),
          ) !== target.importer
        )
          throw lockMismatch("unsafe local source reference");
        const original = edge.spec;
        edge.spec = "workspace:*";
        const packages = portable.packages;
        if (object(packages)) {
          const entry = packages[node.importer === "." ? "" : node.importer];
          if (object(entry))
            for (const group of [
              "dependencies",
              "devDependencies",
              "optionalDependencies",
              "peerDependencies",
            ]) {
              const declarations = entry[group];
              if (object(declarations) && declarations[edge.name] === original)
                declarations[edge.name] = "workspace:*";
            }
        }
      }
  assertPortableLockMetadata(portable);
  // Reuse the strict registry source, URL, bin, platform, and context validator.
  const registry = [...nodes.values()].filter((n) => n.kind === "registry");
  lockedGraph({
    zyrk: {
      version: 1,
      resolver: ZYRK_RESOLVER_POLICY,
      contextCanonicalization: CONTEXT_CANONICALIZATION_VERSION,
      manifest: "sha512-" + "A".repeat(86) + "==",
      scripts: "sha512-" + "A".repeat(86) + "==",
      config: "sha512-" + "A".repeat(86) + "==",
      roots: { ".": {} },
      nodes: Object.fromEntries(
        registry.map((n) => {
          const edges = n.edges.filter(
            (edge) => nodes.get(edge.target)?.kind === "registry",
          );
          return [
            n.key,
            {
              name: n.name,
              version: n.version,
              integrity: n.integrity,
              origin: n.origin,
              source: n.sourceId,
              tarball: n.tarballUrl,
              bin: n.bin,
              platform: n.platform,
              ...(n.engines ? { engines: n.engines } : {}),
              edges: Object.fromEntries(
                edges.map((edge) => [edge.name, edge.target]),
              ),
              edgeKinds: Object.fromEntries(
                edges.map((edge) => [
                  edge.name,
                  edge.kind === "dev" ? "prod" : edge.kind,
                ]),
              ),
              peers: Object.fromEntries(
                Object.entries(n.peers).filter(
                  ([, target]) =>
                    target === null || nodes.get(target)?.kind === "registry",
                ),
              ),
              optionalPeers: n.optionalPeers.filter(
                (name) =>
                  n.peers[name] === null ||
                  nodes.get(n.peers[name]!)?.kind === "registry",
              ),
            },
          ];
        }),
      ),
    },
  });
  if (doc.packages !== undefined) {
    if (!object(doc.packages))
      throw lockMismatch("npm workspace package view is not an object");
    const expected: Record<string, Record<string, unknown>> = {};
    for (const node of nodes.values())
      if (node.kind === "local") {
        const location = node.importer === "." ? "" : node.importer,
          entry = doc.packages[location];
        if (
          !object(entry) ||
          entry.name !== node.name ||
          entry.version !== node.version
        )
          throw lockMismatch("npm workspace importer identity differs");
        expected[location] = structuredClone(entry);
      }
    populateNpmWorkspacePackages(expected, g as unknown as WorkspaceGraph);
    if (canonicalJson(expected) !== canonicalJson(doc.packages))
      throw lockMismatch(
        "npm package selections disagree with the workspace graph",
      );
  }
  return g as unknown as WorkspaceGraph;
}
export async function readWorkspaceLock(
  root: string,
  project?: WorkspaceProject,
  registryOrigin?: string | ((name: string) => string),
): Promise<{ doc: NpmLockDoc; graph: WorkspaceGraph } | null> {
  let text: string;
  try {
    text = await readFile(path.join(root, "package-lock.json"), "utf8");
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return null;
    throw cause;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw lockMismatch("workspace lock is not valid JSON");
  }
  const graph = validateWorkspaceLockDoc(doc);
  if (project) {
    const expected = new Map(project.importers.map((i) => [i.id, i]));
    for (const node of graph.nodes)
      if (node.kind === "local") {
        const item = expected.get(node.importer);
        if (
          !item ||
          node.name !== (item.manifest.name ?? "workspace-root") ||
          node.version !== (item.manifest.version ?? "0.0.0")
        )
          throw lockMismatch("workspace membership changed");
        expected.delete(node.importer);
      }
    if (expected.size) throw lockMismatch("workspace importer is missing");
  }
  if (
    registryOrigin &&
    graph.nodes.some(
      (n) =>
        n.kind === "registry" &&
        n.origin !==
          (typeof registryOrigin === "string"
            ? registryOrigin
            : registryOrigin(n.name)),
    )
  )
    throw lockMismatch("workspace registry origin differs");
  return { doc: doc as NpmLockDoc, graph };
}

/** npm's ordinary virtual tree mirrors every exact registry edge and live importer. */
function populateNpmWorkspacePackages(
  packages: Record<string, Record<string, unknown>>,
  graph: WorkspaceGraph,
): void {
  const byKey = new Map(graph.nodes.map((n) => [n.key, n])),
    placements = new Map<string, string>(),
    populated = new Set<string>();
  const locationOf = (id: string) => (id === "." ? "" : id);
  const slot = (base: string, name: string) =>
    `${base ? base + "/" : ""}node_modules/${name}`;
  const lookup = (location: string, name: string): string | undefined => {
    let current = location;
    for (;;) {
      const candidate = slot(current, name);
      if (placements.has(candidate)) return candidate;
      if (!current) return undefined;
      const index = current.lastIndexOf("/node_modules/");
      current = index < 0 ? "" : current.slice(0, index);
    }
  };
  const populate = (location: string, key: string, depth = 0): void => {
    if (depth > 128 || placements.size > 100000)
      throw lockMismatch("npm workspace projection resource limit exceeded");
    const existing = placements.get(location);
    if (existing !== undefined && existing !== key)
      throw lockMismatch(
        "npm workspace layout cannot represent conflicting peer contexts",
      );
    placements.set(location, key);
    if (populated.has(location)) return;
    populated.add(location);
    const node = byKey.get(key);
    if (!node) throw lockMismatch("missing npm workspace projection node");
    if (node.kind === "local") {
      packages[location] = { resolved: node.importer, link: true };
      return;
    }
    const dependencies: Record<string, string> = {},
      optionalDependencies: Record<string, string> = {},
      peerDependencies: Record<string, string> = {},
      peerDependenciesMeta: Record<string, { optional: true }> = {};
    for (const edge of node.edges) {
      const child = byKey.get(edge.target)!;
      const group =
        edge.kind === "peer"
          ? peerDependencies
          : edge.kind === "optional"
            ? optionalDependencies
            : dependencies;
      group[edge.name] =
        child.name === edge.name
          ? child.version
          : `npm:${child.name}@${child.version}`;
    }
    for (const [name, target] of Object.entries(node.peers)) {
      if (node.optionalPeers.includes(name) || target === null)
        peerDependenciesMeta[name] = { optional: true };
      if (target === null) peerDependencies[name] = "*";
    }
    packages[location] = {
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
      ...(node.engines ? { engines: node.engines } : {}),
    };
    for (const edge of node.edges) {
      const found = lookup(location, edge.name);
      if (found !== undefined && placements.get(found) === edge.target) {
        populate(found, edge.target, depth + 1);
        continue;
      }
      const peerParent = location.slice(
        0,
        Math.max(0, location.lastIndexOf("node_modules/")),
      );
      populate(
        edge.kind === "peer"
          ? `${peerParent}node_modules/${edge.name}`
          : slot(location, edge.name),
        edge.target,
        depth + 1,
      );
    }
  };
  // Reserve all importer selections and standard root workspace links before traversal.
  for (const node of graph.nodes)
    if (node.kind === "local") {
      if (node.importer !== ".") placements.set(slot("", node.name), node.key);
      for (const edge of node.edges)
        placements.set(slot(locationOf(node.importer), edge.name), edge.target);
    }
  for (const [location, key] of [...placements]) populate(location, key);
}
