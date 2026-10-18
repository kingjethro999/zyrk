/** Multi-importer resolution. Live nodes are never registry sources or CAS inputs. */
import { maxSatisfying, satisfies, valid } from "semver";
import {
  expectedIntegrityFromDist,
  type Packument,
  type PackumentVersion,
} from "../fetch/registry.ts";
import type {
  MetadataProvider,
  ResolvedOccurrence,
  RuntimePlatform,
} from "../resolve/resolver.ts";
import { currentPlatform } from "../resolve/resolver.ts";
import {
  workspaceOverrides,
  refineWorkspaceOverride,
  WorkspaceOverrideRestart,
} from "./workspace-overrides.ts";
import { parseRequirement } from "../resolve/spec.ts";
import { sourceIdOf, sha512Hex } from "../util/hash.ts";
import { ZyrkError } from "../errors.ts";
import {
  planWorkspaceDependencies,
  type WorkspaceProject,
  type WorkspaceManifest,
} from "./workspaces.ts";
import { cleanUrl, lockMismatch } from "./lock.ts";

export type WorkspaceEdge = {
  name: string;
  target: string;
  kind: "prod" | "dev" | "optional" | "peer";
  spec: string;
};
export type WorkspaceLocalNode = {
  kind: "local";
  key: string;
  name: string;
  version: string;
  importer: string;
  edges: WorkspaceEdge[];
  peers: Record<string, string | null>;
  optionalPeers: string[];
};
export type WorkspaceRegistryNode = {
  kind: "registry";
  key: string;
  name: string;
  version: string;
  sourceId: string;
  integrity: string;
  origin: string;
  tarballUrl: string;
  bin: Record<string, string>;
  platform: { os?: string[]; cpu?: string[]; libc?: string[] };
  engines?: Record<string, string>;
  edges: WorkspaceEdge[];
  peers: Record<string, string | null>;
  optionalPeers: string[];
};
export type WorkspaceNode = WorkspaceLocalNode | WorkspaceRegistryNode;
export type WorkspaceGraph = {
  nodes: WorkspaceNode[];
  importers: Record<string, string>;
  omissions: Array<{ name: string; parent: string; reason: "platform" }>;
};
const fail = (reason: string): never => {
  throw new ZyrkError(
    "ZYRK_RESOLUTION_FAILED",
    `Cannot resolve workspace graph (${reason}).`,
    {
      remedy:
        "Review workspace declarations, platform constraints and peer requirements before retrying.",
    },
  );
};
class PlatformMismatch extends Error {}
async function resolveWorkspaceGraphPass(
  project: WorkspaceProject,
  provider: MetadataProvider,
  options: {
    previous?: WorkspaceGraph;
    fresh?: ReadonlySet<string>;
    platform?: RuntimePlatform;
    maxNodes?: number;
    maxDepth?: number;
    deadlineMs?: number;
  } = {},
  overrideState = workspaceOverrides(project),
): Promise<WorkspaceGraph> {
  const overrides = overrideState.policy;
  const overrideContexts = new Map(overrideState.contexts);
  const graph: WorkspaceGraph = { nodes: [], importers: {}, omissions: [] };
  const byKey = new Map<string, WorkspaceNode>(),
    manifests = new Map<string, WorkspaceManifest | PackumentVersion>(),
    chains = new Map<string, string[]>();
  const metadata = new Map<string, Promise<Packument>>();
  const platform = options.platform ?? currentPlatform(),
    expires = Date.now() + (options.deadlineMs ?? 30000);
  const check = (depth = 0) => {
    if (
      Date.now() >= expires ||
      graph.nodes.length >= (options.maxNodes ?? 10000) ||
      depth > (options.maxDepth ?? 128)
    )
      fail("resolver resource limit exceeded");
  };
  const byName = new Map(
    project.importers
      .filter((item) => item.id !== ".")
      .map((item) => [item.manifest.name!, item]),
  );
  const importerByNode = new Map<string, string>();
  for (const importer of project.importers) {
    const key = `workspace:${importer.id}`;
    graph.importers[importer.id] = key;
    const node: WorkspaceLocalNode = {
      kind: "local",
      key,
      name: importer.manifest.name ?? "workspace-root",
      version: importer.manifest.version ?? "0.0.0",
      importer: importer.id,
      edges: [],
      peers: {},
      optionalPeers: [],
    };
    graph.nodes.push(node);
    byKey.set(key, node);
    manifests.set(key, importer.manifest);
    chains.set(key, []);
    importerByNode.set(key, importer.id);
  }
  const packument = async (name: string): Promise<Packument> => {
    check();
    let pending = metadata.get(name);
    if (!pending) {
      pending = provider.packument(name);
      metadata.set(name, pending);
    }
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ZyrkError(
                "ZYRK_RESOLUTION_FAILED",
                "Workspace resolution exceeded its deadline.",
              ),
            ),
          Math.max(1, expires - Date.now()),
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const compatible = (entry: PackumentVersion) => {
    for (const [list, actual] of [
      [entry.os, platform.os],
      [entry.cpu, platform.cpu],
      [entry.libc, platform.libc],
    ] as const)
      if (
        list?.length &&
        (!actual ||
          list.includes(`!${actual}`) ||
          (list.some((item) => !item.startsWith("!")) &&
            !list.includes(actual) &&
            !list.includes("any")))
      )
        throw new PlatformMismatch();
    if (
      entry.engines?.node &&
      !satisfies(process.versions.node, entry.engines.node)
    )
      throw new PlatformMismatch();
  };
  const build = async (
    parent: WorkspaceNode,
    name: string,
    spec: string,
    kind: WorkspaceEdge["kind"],
    ancestry: string[],
    explicitLocal?: string,
  ): Promise<string | null> => {
    check(ancestry.length);
    try {
      const overridden = overrides.select(
        overrideContexts.get(parent.key)!,
        name,
        spec,
      );
      if (overridden.spec !== spec) explicitLocal = undefined;
      spec = overridden.spec;
      let local =
        explicitLocal === undefined
          ? undefined
          : project.importers.find((item) => item.id === explicitLocal);
      let requirement: ReturnType<typeof parseRequirement> | undefined;
      if (!local) {
        if (spec.startsWith("workspace:")) {
          const candidate = byName.get(name),
            range = spec.slice(10);
          if (
            !candidate ||
            (!["*", "^", "~"].includes(range) &&
              !satisfies(candidate.manifest.version!, range))
          )
            fail(`unsatisfied workspace peer ${name}`);
          local = candidate;
        } else {
          requirement = parseRequirement(name, spec);
          const candidate = byName.get(name);
          if (
            candidate &&
            requirement.kind !== "alias" &&
            requirement.targetKind !== "tag" &&
            satisfies(candidate.manifest.version!, requirement.targetSpec)
          )
            local = candidate;
        }
      }
      if (local) {
        const key = graph.importers[local.id]!;
        refineWorkspaceOverride(
          overrideState.contexts,
          key,
          overridden.context,
        );
        return key;
      }
      if (!requirement) throw lockMismatch("missing workspace requirement");
      const doc = await packument(requirement.realName);
      const priorEdge = options.previous?.nodes
        .find((n) => n.key === parent.key)
        ?.edges.find((e) => e.name === name);
      const prior = options.previous?.nodes.find(
        (n) => n.key === priorEdge?.target,
      );
      const keepPrior =
        !options.fresh?.has(`${importerByNode.get(parent.key)!}\0${name}`) &&
        prior?.kind === "registry" &&
        prior.name === requirement.realName &&
        (requirement.targetKind === "tag" ||
          satisfies(prior.version, requirement.targetSpec)) &&
        doc.versions[prior.version];
      const selectedVersion = keepPrior
        ? prior!.version
        : requirement.targetKind === "exact"
          ? requirement.targetSpec
          : requirement.targetKind === "tag"
            ? doc.distTags[requirement.targetSpec]
            : maxSatisfying(
                Object.keys(doc.versions).filter((value) => valid(value)),
                requirement.targetSpec,
              );
      if (!selectedVersion || !doc.versions[selectedVersion])
        return fail(`no matching registry selection for ${name}`);
      const version = selectedVersion;
      const entry = doc.versions[version]!;
      if (
        keepPrior &&
        prior?.kind === "registry" &&
        expectedIntegrityFromDist(entry.dist) !== prior.integrity
      )
        throw lockMismatch(
          "retained workspace source integrity changed at the registry",
        );
      compatible(entry);
      const integrity = expectedIntegrityFromDist(entry.dist);
      if (!integrity)
        throw new ZyrkError(
          "ZYRK_INTEGRITY_FAILED",
          `Cannot resolve strong integrity for ${requirement.realName}@${version}.`,
        );
      const ancestor = [...ancestry, parent.key]
        .reverse()
        .map((key) => byKey.get(key))
        .find(
          (node) =>
            node?.kind === "registry" &&
            node.name === requirement!.realName &&
            node.version === version &&
            overrideContexts.get(node.key)?.id === overridden.context.id,
        );
      if (ancestor) return ancestor.key;
      const key = `${requirement.realName}@${version}#${sha512Hex(parent.key + "\0" + name).slice(0, 16)}`;
      if (byKey.has(key)) return key;
      const origin =
        provider.originFor?.(requirement.realName) ?? provider.origin;
      if (!cleanUrl(origin) || !cleanUrl(entry.dist.tarball))
        fail("unsafe registry source metadata");
      const bin: Record<string, string> =
        typeof entry.bin === "string"
          ? { [requirement.realName.split("/").at(-1)!]: entry.bin }
          : (entry.bin ?? {});
      const node: WorkspaceRegistryNode = {
        kind: "registry",
        key,
        name: requirement.realName,
        version,
        sourceId: sourceIdOf({
          sourceType: "registry",
          name: requirement.realName,
          version,
          origin,
          integrity,
        }),
        origin,
        integrity,
        tarballUrl: entry.dist.tarball,
        bin,
        platform: {
          ...(entry.os ? { os: entry.os } : {}),
          ...(entry.cpu ? { cpu: entry.cpu } : {}),
          ...(entry.libc ? { libc: entry.libc } : {}),
        },
        ...(entry.engines ? { engines: entry.engines } : {}),
        edges: [],
        peers: {},
        optionalPeers: [],
      };
      graph.nodes.push(node);
      overrideContexts.set(key, overridden.context);
      byKey.set(key, node);
      manifests.set(key, entry);
      chains.set(key, [...ancestry, parent.key]);
      importerByNode.set(key, importerByNode.get(parent.key)!);
      if (
        entry.bundledDependencies === true ||
        (Array.isArray(entry.bundledDependencies) &&
          entry.bundledDependencies.length)
      )
        fail(
          "bundled registry packages require an explicit supported workspace adapter",
        );
      const regular = { ...entry.dependencies, ...entry.optionalDependencies };
      for (const [dep, range] of Object.entries(regular).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        const edgeKind = Object.hasOwn(entry.optionalDependencies ?? {}, dep)
          ? "optional"
          : "prod";
        const target = await build(node, dep, range, edgeKind, [
          ...ancestry,
          parent.key,
        ]);
        if (target)
          node.edges.push({ name: dep, target, kind: edgeKind, spec: range });
      }
      return key;
    } catch (cause) {
      if (cause instanceof PlatformMismatch && kind === "optional") {
        graph.omissions.push({ name, parent: parent.key, reason: "platform" });
        return null;
      }
      if (cause instanceof PlatformMismatch)
        throw new ZyrkError(
          "ZYRK_PLATFORM_UNSUPPORTED",
          `Required workspace dependency ${name} is incompatible with this platform.`,
          { remedy: "Select a compatible dependency version or platform." },
        );
      throw cause;
    }
  };
  for (const plan of planWorkspaceDependencies(project)) {
    const node = byKey.get(graph.importers[plan.importer.id]!)!;
    for (const edge of plan.dependencies)
      if (edge.kind !== "peer") {
        const target = await build(
          node,
          edge.name,
          edge.spec,
          edge.kind,
          [],
          edge.selection.kind === "local" ? edge.selection.importer : undefined,
        );
        if (target)
          node.edges.push({
            name: edge.name,
            target,
            kind: edge.kind,
            spec: edge.spec,
          });
      }
  }
  for (let round = 0; round < 1024; round++) {
    let changed = false;
    for (const node of graph.nodes) {
      check();
      const manifest = manifests.get(node.key)!;
      for (const [name, rawRange] of Object.entries(
        manifest.peerDependencies ?? {},
      ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const range = overrides.select(
          overrideContexts.get(node.key)!,
          name,
          rawRange,
        ).spec;
        const optional =
          manifest.peerDependenciesMeta?.[name]?.optional === true;
        if (optional && !node.optionalPeers.includes(name))
          node.optionalPeers.push(name);
        const levels = [
          node.key,
          ...[...(chains.get(node.key) ?? [])].reverse(),
        ];
        let target: string | undefined;
        for (const key of levels) {
          const found = byKey
            .get(key)!
            .edges.find((edge) => edge.name === name);
          if (found) {
            target = found.target;
            break;
          }
        }
        if (target) {
          const selected = byKey.get(target)!;
          const requested = range.startsWith("workspace:")
            ? range.slice(10)
            : parseRequirement(name, range).targetSpec;
          if (
            !["*", "^", "~"].includes(requested) &&
            !satisfies(selected.version, requested)
          )
            throw new ZyrkError(
              "ZYRK_PEER_CONFLICT",
              `Workspace peer ${name} required by ${node.name} conflicts with its consumer.`,
              { remedy: "Align the consumer and package peer requirements." },
            );
        } else if (!optional)
          target = (await build(
            node,
            name,
            range,
            "peer",
            chains.get(node.key) ?? [],
          ))!;
        const binding = target ?? null;
        if (node.peers[name] !== binding) {
          node.peers[name] = binding;
          changed = true;
        }
        if (target && !node.edges.some((edge) => edge.name === name)) {
          node.edges.push({ name, target, kind: "peer", spec: range });
          changed = true;
        }
      }
    }
    if (!changed) {
      const reachable = new Set<string>(),
        pending = Object.values(graph.importers);
      while (pending.length) {
        const key = pending.pop()!;
        if (reachable.has(key)) continue;
        reachable.add(key);
        for (const edge of byKey.get(key)!.edges) pending.push(edge.target);
      }
      graph.omissions = graph.omissions.filter((item) =>
        reachable.has(item.parent),
      );
      graph.nodes = graph.nodes
        .filter((node) => reachable.has(node.key))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return graph;
    }
  }
  return fail("peer binding iteration limit exceeded");
}
/** Retry pure planning when a registry edge narrows a live importer's scope. */
export async function resolveWorkspaceGraph(
  project: WorkspaceProject,
  provider: MetadataProvider,
  options: Parameters<typeof resolveWorkspaceGraphPass>[2] = {},
): Promise<WorkspaceGraph> {
  const state = workspaceOverrides(project),
    expires = Date.now() + (options.deadlineMs ?? 30000);
  const packuments = new Map<
    string,
    ReturnType<MetadataProvider["packument"]>
  >();
  const cached = {
    ...provider,
    origin: provider.origin,
    ...(provider.originFor
      ? { originFor: (name: string) => provider.originFor!(name) }
      : {}),
    packument: (name: string) => {
      let pending = packuments.get(name);
      if (!pending) {
        pending = provider.packument(name);
        packuments.set(name, pending);
      }
      return pending;
    },
  };
  for (let round = 0; round < 128 && Date.now() < expires; round++) {
    try {
      return await resolveWorkspaceGraphPass(
        project,
        cached,
        { ...options, deadlineMs: Math.max(1, expires - Date.now()) },
        state,
      );
    } catch (cause) {
      if (!(cause instanceof WorkspaceOverrideRestart)) throw cause;
    }
  }
  throw lockMismatch("workspace override planning resource limit exceeded");
}
export function workspaceRegistryOccurrences(
  graph: WorkspaceGraph,
): ResolvedOccurrence[] {
  return graph.nodes
    .filter((node): node is WorkspaceRegistryNode => node.kind === "registry")
    .map((node) => ({
      ...node,
      edges: node.edges.map((edge) => ({
        ...edge,
        kind: edge.kind === "dev" ? "prod" : edge.kind,
      })),
      peerBindings: Object.entries(node.peers).map(([name, target]) => ({
        name,
        target,
        ...(node.optionalPeers.includes(name) ? { optional: true } : {}),
      })),
    }));
}

/** Rooted semantic context including live source identity; occurrence keys never split equal peers. */
export function workspaceContextId(
  graph: WorkspaceGraph,
  rootKey: string,
  projectId: string,
): string {
  const byKey = new Map(graph.nodes.map((n) => [n.key, n])),
    numbers = new Map<string, number>(),
    order: string[] = [];
  const visit = (key: string): void => {
    if (numbers.has(key)) return;
    const node = byKey.get(key);
    if (!node) throw lockMismatch("workspace context reaches a missing node");
    numbers.set(key, order.length);
    order.push(key);
    for (const edge of [...node.edges].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ))
      visit(edge.target);
  };
  visit(rootKey);
  return `ctx1_${sha512Hex(
    JSON.stringify(
      order.map((key) => {
        const node = byKey.get(key)!;
        return [
          node.kind,
          node.name,
          node.version,
          node.kind === "local" ? [projectId, node.importer] : node.sourceId,
          [...node.edges]
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map((edge) => [edge.name, numbers.get(edge.target)]),
        ];
      }),
    ),
  )}`;
}

/** Recheck locked platform/runtime requirements as strictly as fresh resolution. */
export function assertWorkspacePlatform(graph: WorkspaceGraph): void {
  const platform = currentPlatform();
  for (const node of graph.nodes)
    if (node.kind === "registry") {
      for (const [list, actual] of [
        [node.platform.os, platform.os],
        [node.platform.cpu, platform.cpu],
        [node.platform.libc, platform.libc],
      ] as const)
        if (
          list?.length &&
          (!actual ||
            list.includes(`!${actual}`) ||
            (list.some((item) => !item.startsWith("!")) &&
              !list.includes(actual) &&
              !list.includes("any")))
        )
          throw new ZyrkError(
            "ZYRK_PLATFORM_UNSUPPORTED",
            `Workspace dependency ${node.name}@${node.version} is incompatible with this platform.`,
            {
              remedy:
                "Select a compatible package or platform before retrying.",
            },
          );
      if (
        node.engines?.node &&
        !satisfies(process.versions.node, node.engines.node)
      )
        throw new ZyrkError(
          "ZYRK_PLATFORM_UNSUPPORTED",
          `Workspace dependency ${node.name}@${node.version} requires a different Node.js runtime.`,
          {
            remedy:
              "Use a runtime satisfying the locked engines.node requirement.",
          },
        );
    }
}
