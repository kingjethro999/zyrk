/** Translate npm's physical virtual tree without selecting new registry versions. */
import * as path from "node:path";
import { satisfies } from "semver";
import type { NpmLockDoc } from "../lockfile/types.ts";
import { validateLockDoc } from "../lockfile/read.ts";
import { sha512Hex } from "../util/hash.ts";
import { canonicalJson } from "../util/json.ts";
import { importNpmLock } from "./import-npm.ts";
import { lockMismatch, cleanUrl } from "./lock.ts";
import { ZyrkError } from "../errors.ts";
import { assertWorkspacePlatform } from "./workspace-graph.ts";
import type { WorkspaceProject } from "./workspaces.ts";
import type {
  WorkspaceGraph,
  WorkspaceNode,
  WorkspaceEdge,
} from "./workspace-graph.ts";

export function importNpmWorkspaceLock(
  doc: NpmLockDoc,
  project: WorkspaceProject,
  origin: string,
): WorkspaceGraph {
  if (
    !doc ||
    typeof doc !== "object" ||
    Array.isArray(doc) ||
    !doc.packages ||
    typeof doc.packages !== "object" ||
    Array.isArray(doc.packages) ||
    Object.values(doc.packages).some(
      (e) => !e || typeof e !== "object" || Array.isArray(e),
    )
  )
    throw lockMismatch("npm workspace lock has malformed package entries");
  const portable = structuredClone(doc);
  // Relative file declarations are representable only when they name a
  // discovered live importer. Validate their targets before URL validation.
  const importerIds = new Set(
    project.importers.map((i) => (i.id === "." ? "" : i.id)),
  );
  for (const [location, entry] of Object.entries(portable.packages ?? {}))
    for (const group of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ])
      if (entry[group] && typeof entry[group] === "object")
        for (const [name, spec] of Object.entries(
          entry[group] as Record<string, unknown>,
        ))
          if (typeof spec === "string" && spec.startsWith("file:")) {
            const relative = spec.slice(5);
            if (
              !importerIds.has(location) ||
              relative.startsWith("/") ||
              relative.includes("\\") ||
              /^[A-Za-z]:/.test(relative) ||
              !importerIds.has(
                path.posix.normalize(path.posix.join(location, relative)),
              )
            )
              throw lockMismatch(
                "npm file declaration is not a declared workspace",
              );
            (entry[group] as Record<string, unknown>)[name] = "workspace:*";
          }
  // npm v2 also has a redundant legacy dependency view. Do not adopt a
  // second authority; it is still scanned for unsafe metadata.
  const sanitizeLegacyLinks = (value: unknown): unknown => {
    if (
      typeof value === "string" &&
      value.startsWith("file:") &&
      importerIds.has(value.slice(5))
    )
      return "workspace:*";
    if (Array.isArray(value)) return value.map(sanitizeLegacyLinks);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          sanitizeLegacyLinks(child),
        ]),
      );
    return value;
  };
  if (portable.dependencies)
    portable.dependencies = sanitizeLegacyLinks(
      portable.dependencies,
    ) as Record<string, unknown>;
  validateLockDoc(portable, "package-lock.json");
  if (
    doc.zyrk ||
    ![2, 3].includes(doc.lockfileVersion ?? 0) ||
    !doc.packages ||
    !cleanUrl(origin)
  )
    throw lockMismatch(
      "workspace adoption needs an unannotated npm v2/v3 lock",
    );
  const packages = doc.packages;
  const graph: WorkspaceGraph = { nodes: [], importers: {}, omissions: [] };
  const locations = new Map<string, WorkspaceNode>();
  const local = new Map(
    project.importers.map((i) => [i.id === "." ? "" : i.id, i]),
  );
  for (const [location, entry] of Object.entries(packages)) {
    if (
      location.includes("\\") ||
      location.startsWith("/") ||
      location.split("/").some((s) => s === ".." || s === ".") ||
      location.includes("\0")
    )
      throw lockMismatch("unsafe npm package location");
    if (
      entry.link === true &&
      (typeof entry.resolved !== "string" ||
        !local.has(entry.resolved) ||
        entry.resolved === "")
    )
      throw lockMismatch("npm link does not select a declared workspace");
    if (entry.inBundle === true)
      throw lockMismatch("bundled npm selections are unsupported");
  }
  for (const [location, importer] of local) {
    const entry = packages[location];
    if (!entry || entry.link)
      throw lockMismatch("npm lock lacks a workspace importer");
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "workspaces",
    ])
      if (
        canonicalJson(entry[field] ?? {}) !==
        canonicalJson(importer.manifest[field] ?? {})
      )
        throw lockMismatch("npm workspace manifest declarations differ");
    if (
      location &&
      ((entry.name !== undefined && entry.name !== importer.manifest.name) ||
        entry.version !== importer.manifest.version)
    )
      throw lockMismatch("npm workspace identity differs");
    const node: WorkspaceNode = {
      kind: "local",
      key: `workspace:${importer.id}`,
      name: importer.manifest.name ?? "workspace-root",
      version: importer.manifest.version ?? "0.0.0",
      importer: importer.id,
      edges: [],
      peers: {},
      optionalPeers: [],
    };
    graph.importers[importer.id] = node.key;
    graph.nodes.push(node);
    locations.set(location, node);
  }
  const find = (from: string, name: string): string | undefined => {
    let current = from;
    for (;;) {
      if (!current.endsWith("node_modules")) {
        const slot = `${current ? current + "/" : ""}node_modules/${name}`;
        if (Object.hasOwn(packages, slot)) return slot;
      }
      if (!current) return undefined;
      current = current.includes("/")
        ? current.slice(0, current.lastIndexOf("/"))
        : "";
    }
  };
  const populated = new Set<string>();
  const load = (
    location: string,
    name: string,
    spec: string,
    from: string,
  ): WorkspaceNode => {
    const entry = packages[location]!;
    if (entry.link === true) {
      const target = locations.get(entry.resolved as string)!;
      const range = spec.startsWith("workspace:") ? spec.slice(10) : spec;
      if (
        spec.startsWith("file:")
          ? path.posix.normalize(path.posix.join(from, spec.slice(5))) !==
            (target.kind === "local" ? target.importer : "")
          : name !== target.name ||
            (!["*", "^", "~"].includes(range) &&
              !satisfies(target.version, range))
      )
        throw lockMismatch("npm workspace link disagrees with requirement");
      return target;
    }
    // Reuse the strict single-selection adapter's archive, alias, source and
    // platform validation. Dependencies are wired below using npm locations.
    const shallow = { ...entry };
    delete shallow.dependencies;
    delete shallow.optionalDependencies;
    delete shallow.peerDependencies;
    const selected = importNpmLock(
      {
        lockfileVersion: 3,
        packages: { "": {}, [`node_modules/${name}`]: shallow },
      },
      { [name]: spec },
      origin,
    ).nodes[0]!;
    let node = locations.get(location);
    if (!node) {
      const { peerBindings: _bindings, ...source } = selected;
      node = {
        ...source,
        key: `${selected.name}@${selected.version}#${sha512Hex(location).slice(0, 16)}`,
        kind: "registry",
        edges: [],
        peers: {},
        optionalPeers: [],
      };
      assertWorkspacePlatform({ nodes: [node], importers: {}, omissions: [] });
      graph.nodes.push(node);
      locations.set(location, node);
    }
    try {
      populate(location, node);
    } catch (cause) {
      populated.delete(location);
      locations.delete(location);
      graph.nodes = graph.nodes.filter((n) => n !== node);
      throw cause;
    }
    return node;
  };
  const populate = (location: string, node: WorkspaceNode): void => {
    if (populated.has(location)) return;
    if (populated.size >= 10000)
      throw lockMismatch("npm import resource limit exceeded");
    populated.add(location);
    const entry = packages[location]!;
    const requirements = new Map<
      string,
      { spec: string; kind: WorkspaceEdge["kind"] }
    >();
    for (const [field, kind] of [
      ["dependencies", "prod"],
      ["devDependencies", "dev"],
      ["optionalDependencies", "optional"],
      ["peerDependencies", "peer"],
    ] as const) {
      if (kind === "dev" && node.kind !== "local") continue;
      const values = entry[field];
      if (values === undefined) continue;
      if (!values || typeof values !== "object" || Array.isArray(values))
        throw lockMismatch("invalid npm dependency declarations");
      for (const [name, spec] of Object.entries(values)) {
        if (typeof spec !== "string")
          throw lockMismatch("invalid npm dependency requirement");
        // A peer declaration does not replace an existing regular dependency.
        if (kind !== "peer" || !requirements.has(name))
          requirements.set(name, { spec, kind });
      }
    }
    for (const [name, requirement] of requirements) {
      const meta = entry.peerDependenciesMeta as
        Record<string, { optional?: boolean }> | undefined;
      const optionalPeer =
        requirement.kind === "peer" && meta?.[name]?.optional === true;
      if (optionalPeer) node.optionalPeers.push(name);
      const targetLocation = find(location, name);
      if (targetLocation === undefined) {
        if (optionalPeer) {
          node.peers[name] = null;
          continue;
        }
        if (requirement.kind === "optional") continue;
        throw lockMismatch(
          "npm workspace lock is missing a required selection",
        );
      }
      let target: WorkspaceNode;
      try {
        target = load(targetLocation, name, requirement.spec, location);
      } catch (cause) {
        if (
          requirement.kind === "optional" &&
          cause instanceof ZyrkError &&
          cause.code === "ZYRK_PLATFORM_UNSUPPORTED"
        ) {
          graph.omissions.push({ name, parent: node.key, reason: "platform" });
          continue;
        }
        throw cause;
      }
      node.edges.push({ name, target: target.key, ...requirement });
      if (requirement.kind === "peer") node.peers[name] = target.key;
    }
    // npm allows the same name in dependencies and peerDependencies. Its
    // ordinary edge keeps its kind, but the peer range and binding still apply.
    const peers = entry.peerDependencies as Record<string, string> | undefined;
    const meta = entry.peerDependenciesMeta as
      Record<string, { optional?: boolean }> | undefined;
    for (const [name, spec] of Object.entries(peers ?? {})) {
      if (Object.hasOwn(node.peers, name)) continue;
      const optional = meta?.[name]?.optional === true;
      if (optional) node.optionalPeers.push(name);
      const targetLocation = find(location, name);
      if (targetLocation === undefined) {
        if (!optional)
          throw lockMismatch("npm workspace lock is missing a required peer");
        node.peers[name] = null;
        continue;
      }
      const target = load(targetLocation, name, spec, location);
      node.peers[name] = target.key;
      if (!node.edges.some((edge) => edge.name === name))
        node.edges.push({ name, target: target.key, kind: "peer", spec });
    }
  };
  for (const [location] of local) populate(location, locations.get(location)!);
  const reachable = new Set<string>(),
    pending = Object.values(graph.importers),
    byKey = new Map(graph.nodes.map((n) => [n.key, n]));
  while (pending.length) {
    const key = pending.pop()!;
    if (reachable.has(key)) continue;
    reachable.add(key);
    for (const edge of byKey.get(key)!.edges) pending.push(edge.target);
  }
  graph.nodes = graph.nodes.filter((n) => reachable.has(n.key));
  graph.omissions = graph.omissions.filter((o) => reachable.has(o.parent));
  graph.nodes.sort((a, b) => a.key.localeCompare(b.key));
  return graph;
}
