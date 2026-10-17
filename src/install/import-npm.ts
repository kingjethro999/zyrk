/** Adopt npm v2/v3 exact selections without asking the registry to pick versions. */
import { validateLockDoc } from "../lockfile/read.ts";
import { valid, satisfies } from "semver";
import type { NpmLockDoc } from "../lockfile/types.ts";
import type {
  FinalizedGraph,
  ResolvedOccurrence,
} from "../resolve/resolver.ts";
import { parseRequirement } from "../resolve/spec.ts";
import { sourceIdOf, sha512Hex } from "../util/hash.ts";
import { cleanUrl, lockMismatch, packageName } from "./lock.ts";

export function importNpmLock(
  doc: NpmLockDoc,
  requirements: Record<string, string>,
  origin: string,
): FinalizedGraph {
  validateLockDoc(doc, "package-lock.json");
  const packages = doc.packages;
  if (!packages || !packages[""])
    throw lockMismatch("npm lockfile lacks an importer manifest");
  const locations = new Map<string, ResolvedOccurrence>();
  const find = (from: string, name: string): string | undefined => {
    let current = from;
    for (;;) {
      if (!current.endsWith("node_modules")) {
        const candidate = `${current ? `${current}/` : ""}node_modules/${name}`;
        if (packages[candidate]) return candidate;
      }
      if (!current) return undefined;
      current = current.includes("/")
        ? current.slice(0, current.lastIndexOf("/"))
        : "";
    }
  };
  const load = (
    location: string,
    edgeName: string,
    spec: string,
  ): ResolvedOccurrence => {
    const existing = locations.get(location);
    const entry = packages[location];
    if (!entry || entry.link === true || entry.inBundle === true)
      throw lockMismatch(
        "npm lock contains an unsupported linked or bundled selection",
      );
    const request = parseRequirement(edgeName, spec);
    const name = typeof entry.name === "string" ? entry.name : request.realName;
    if (
      !packageName(name) ||
      name !== request.realName ||
      typeof entry.version !== "string" ||
      valid(entry.version) === null ||
      typeof entry.resolved !== "string" ||
      !cleanUrl(entry.resolved) ||
      typeof entry.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)
    )
      throw lockMismatch(
        "npm selection lacks a valid name, version, archive, or SHA-512 integrity",
      );
    if (
      request.targetKind !== "tag" &&
      !satisfies(entry.version, request.targetSpec)
    )
      throw lockMismatch("npm selection disagrees with a manifest requirement");
    // Every incoming edge must satisfy its requirement, including a cycle or
    // a location already selected by a different dependency.
    if (existing) return existing;
    const node: ResolvedOccurrence = {
      key: `${name}@${entry.version}#${sha512Hex(location).slice(0, 16)}`,
      name,
      version: entry.version,
      origin,
      integrity: entry.integrity,
      sourceId: sourceIdOf({
        sourceType: "registry",
        name,
        version: entry.version,
        origin,
        integrity: entry.integrity,
      }),
      tarballUrl: entry.resolved,
      bin: {},
      platform: {},
      edges: [],
      peerBindings: [],
    };
    if (entry.engines !== undefined) {
      if (
        typeof entry.engines !== "object" ||
        entry.engines === null ||
        Array.isArray(entry.engines) ||
        Object.values(entry.engines).some((value) => typeof value !== "string")
      )
        throw lockMismatch("invalid npm engine constraint");
      node.engines = entry.engines as Record<string, string>;
    }
    if (
      typeof entry.bin === "object" &&
      entry.bin !== null &&
      !Array.isArray(entry.bin)
    ) {
      for (const [key, value] of Object.entries(entry.bin)) {
        if (typeof value !== "string")
          throw lockMismatch("invalid npm binary entry");
        node.bin[key] = value;
      }
    }
    for (const field of ["os", "cpu", "libc"] as const) {
      const value = entry[field];
      if (value !== undefined) {
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
          throw lockMismatch("invalid npm platform constraint");
        node.platform[field] = value as string[];
      }
    }
    locations.set(location, node);
    const dependencies: Record<
      string,
      { spec: string; kind: "prod" | "optional" | "peer" }
    > = Object.create(null) as Record<
      string,
      { spec: string; kind: "prod" | "optional" | "peer" }
    >;
    for (const [group, kind] of [
      ["dependencies", "prod"],
      ["optionalDependencies", "optional"],
      ["peerDependencies", "peer"],
    ] as const) {
      const entries = entry[group];
      if (entries === undefined) continue;
      if (
        typeof entries !== "object" ||
        entries === null ||
        Array.isArray(entries)
      )
        throw lockMismatch("invalid npm dependency declarations");
      for (const [dep, range] of Object.entries(entries)) {
        if (!packageName(dep) || typeof range !== "string")
          throw lockMismatch("invalid npm dependency requirement");
        dependencies[dep] = { spec: range, kind };
      }
    }
    for (const [dep, requirement] of Object.entries(dependencies)) {
      const targetLocation = find(location, dep);
      const meta = entry.peerDependenciesMeta as
        Record<string, { optional?: boolean }> | undefined;
      const optionalPeer =
        requirement.kind === "peer" && meta?.[dep]?.optional === true;
      if (!targetLocation) {
        if (requirement.kind === "optional" || optionalPeer) {
          if (optionalPeer)
            node.peerBindings.push({ name: dep, target: null, optional: true });
          continue;
        }
        throw lockMismatch("npm lock is missing a required dependency");
      }
      const target = load(targetLocation, dep, requirement.spec);
      node.edges.push({
        name: dep,
        target: target.key,
        kind: requirement.kind,
        spec: requirement.spec,
      });
      if (requirement.kind === "peer")
        node.peerBindings.push({
          name: dep,
          target: target.key,
          ...(optionalPeer ? { optional: true } : {}),
        });
    }
    return node;
  };
  const roots = Object.entries(requirements).map(([name, spec]) => {
    const location = find("", name);
    if (!location) throw lockMismatch("npm lock is missing a direct selection");
    return { name, target: load(location, name, spec).key };
  });
  return {
    nodes: [...locations.values()].sort((a, b) => a.key.localeCompare(b.key)),
    roots,
  };
}
