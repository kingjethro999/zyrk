/** Portable selections stay in the lock; only a compatible closure is realized. */
import { satisfies } from "semver";
import { ZyrkError } from "../errors.ts";
import {
  currentPlatform,
  type RuntimePlatform,
  type FinalizedGraph,
} from "../resolve/resolver.ts";
import type { WorkspaceGraph } from "./workspace-graph.ts";
import { lockMismatch } from "./lock.ts";

/** Summarize expected platform filtering without emitting one warning per variant. */
export function platformOmissionSummary(
  omissions: readonly { name: string }[],
): string | undefined {
  if (omissions.length === 0) return undefined;
  const packages = new Set(omissions.map((item) => item.name));
  const entries = omissions.length;
  const variants = packages.size;
  const entryLabel = `${entries} platform-specific optional ${entries === 1 ? "dependency" : "dependencies"}`;
  const packageLabel = `${variants} ${variants === 1 ? "package variant" : "package variants"}`;
  return `Skipped ${entryLabel} across ${packageLabel}; this is expected when selecting dependencies for the current platform.`;
}

type Edge = { name: string; target: string; kind: string };
type Selection = {
  key: string;
  name: string;
  version: string;
  platform?: { os?: string[]; cpu?: string[]; libc?: string[] };
  engines?: Record<string, string>;
  edges: Edge[];
  peerBindings?: Array<{
    name: string;
    target: string | null;
    optional?: boolean;
  }>;
  optionalPeers?: string[];
};
function compatible(node: Selection, platform: RuntimePlatform): boolean {
  return (
    (
      [
        [node.platform?.os, platform.os],
        [node.platform?.cpu, platform.cpu],
        [node.platform?.libc, platform.libc],
      ] as const
    ).every(
      ([list, actual]) =>
        !list?.length ||
        (!!actual &&
          !list.includes(`!${actual}`) &&
          (!list.some((v) => !v.startsWith("!")) ||
            list.includes(actual) ||
            list.includes("any"))),
    ) &&
    (!node.engines?.node || satisfies(process.versions.node, node.engines.node))
  );
}
function optional(node: Selection, edge: Edge): boolean {
  return (
    edge.kind === "optional" ||
    (edge.kind === "peer" &&
      (node.optionalPeers?.includes(edge.name) === true ||
        node.peerBindings?.some((p) => p.name === edge.name && p.optional) ===
          true))
  );
}
function select<T extends Selection>(
  nodes: T[],
  roots: Array<{ name: string; target: string; optional?: boolean }>,
  platform: RuntimePlatform,
) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const viable = new Set(
    nodes.filter((n) => compatible(n, platform)).map((n) => n.key),
  );
  // Propagate required incompatibility back to the nearest optional boundary.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes)
      if (
        viable.has(node.key) &&
        node.edges.some((e) => !optional(node, e) && !viable.has(e.target))
      ) {
        viable.delete(node.key);
        changed = true;
      }
  }
  const active = new Set<string>();
  const omissions: Array<{ name: string; parent: string; reason: "platform" }> =
    [];
  const visit = (
    name: string,
    target: string,
    isOptional: boolean,
    parent: string,
  ): void => {
    if (!byKey.has(target)) throw lockMismatch("missing platform selection");
    if (!viable.has(target)) {
      if (isOptional) {
        omissions.push({ name, parent, reason: "platform" });
        return;
      }
      throw new ZyrkError(
        "ZYRK_PLATFORM_UNSUPPORTED",
        `Cannot install required dependency ${name} on the selected platform or Node.js runtime.`,
        {
          remedy:
            "Select a compatible package version, platform, or Node.js runtime.",
        },
      );
    }
    if (active.has(target)) return;
    active.add(target);
    const node = byKey.get(target)!;
    for (const edge of node.edges)
      visit(edge.name, edge.target, optional(node, edge), node.key);
  };
  for (const root of roots)
    visit(root.name, root.target, root.optional === true, "<root>");
  return { active, viable, omissions };
}
export function selectPlatformGraph(
  graph: FinalizedGraph,
  optionalRoots: ReadonlySet<string>,
  platform = currentPlatform(),
): FinalizedGraph {
  const { active, viable, omissions } = select(
    graph.nodes,
    graph.roots.map((r) => ({ ...r, optional: optionalRoots.has(r.name) })),
    platform,
  );
  return {
    roots: graph.roots.filter((r) => active.has(r.target)),
    omissions,
    nodes: graph.nodes
      .filter((n) => active.has(n.key))
      .map((n) => ({
        ...n,
        edges: n.edges.filter((e) => viable.has(e.target)),
        peerBindings: n.peerBindings.map((p) =>
          p.target !== null && !viable.has(p.target)
            ? { ...p, target: null }
            : p,
        ),
      })),
  };
}
export function selectWorkspacePlatform(
  graph: WorkspaceGraph,
  platform = currentPlatform(),
  omitDev = false,
): WorkspaceGraph {
  if (omitDev)
    graph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.kind === "local"
          ? { ...node, edges: node.edges.filter((edge) => edge.kind !== "dev") }
          : node,
      ),
    };
  const { active, viable, omissions } = select(
    graph.nodes,
    Object.entries(graph.importers).map(([name, target]) => ({ name, target })),
    platform,
  );
  return {
    ...graph,
    omissions,
    nodes: graph.nodes
      .filter((n) => active.has(n.key))
      .map((n) => ({
        ...n,
        edges: n.edges.filter((e) => viable.has(e.target)),
        peers: Object.fromEntries(
          Object.entries(n.peers).map(([name, target]) => [
            name,
            target !== null && !viable.has(target) ? null : target,
          ]),
        ),
      })),
  };
}
