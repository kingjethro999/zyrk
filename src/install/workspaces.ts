/** Workspace discovery and live-source planning (§21). This module never installs.
 * Publication still requires one transaction covering every importer projection.
 */
import { lstat, readFile, opendir, realpath } from "node:fs/promises";
import * as path from "node:path";
import { valid, validRange, satisfies } from "semver";
import { ZyrkError } from "../errors.ts";
import { isErrno } from "../util/fsx.ts";
import { sha512Hex } from "../util/hash.ts";
import { canonicalJson } from "../util/json.ts";
import {
  manifestFingerprint,
  type ManifestDeclaration,
} from "../lockfile/fingerprints.ts";
import { packageName } from "./lock.ts";
import { parseRequirement, type ParsedRequirement } from "../resolve/spec.ts";

export type WorkspaceManifest = ManifestDeclaration & {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  [key: string]: unknown;
};
export type WorkspaceImporter = {
  /** Portable importer location, '.' for the authoritative workspace root. */
  id: string;
  directory: string;
  manifest: WorkspaceManifest;
  /** Local mutable sources never receive a registry/CAS source identity. */
  source: { kind: "live-directory"; projectContext: string; importer: string };
};
export type WorkspaceProject = {
  root: string;
  importers: WorkspaceImporter[];
  manifestFingerprint: string;
};
function invalid(why: string): never {
  throw new ZyrkError(
    "ZYRK_MANIFEST_INVALID",
    `Cannot plan workspace dependencies (${why}).`,
    {
      remedy:
        "Use unique named workspace packages, valid manifests, and real package directories inside the workspace root.",
    },
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function readManifest(
  directory: string,
  id: string,
): Promise<WorkspaceManifest> {
  let raw: unknown;
  try {
    const file = path.join(directory, "package.json");
    if (!(await lstat(file)).isFile())
      invalid(`importer ${id} manifest must be a regular file`);
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    if (cause instanceof ZyrkError) throw cause;
    invalid(`importer ${id} has no readable JSON manifest`);
  }
  if (!object(raw)) invalid(`importer ${id} manifest must be an object`);
  if (
    raw.name !== undefined &&
    (typeof raw.name !== "string" || !packageName(raw.name))
  )
    invalid(`importer ${id} has an invalid package name`);
  if (
    raw.version !== undefined &&
    (typeof raw.version !== "string" || valid(raw.version) === null)
  )
    invalid(`importer ${id} has an invalid version`);
  if (id !== "." && (raw.name === undefined || raw.version === undefined))
    invalid(`importer ${id} needs a package name and version`);
  if (id !== "." && (raw.workspaces !== undefined || raw.zyrk !== undefined))
    invalid(
      `importer ${id} overrides root-owned workspace or zyrk configuration`,
    );
  for (const group of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "scripts",
  ] as const) {
    const entries = raw[group];
    if (entries === undefined) continue;
    if (
      !object(entries) ||
      Object.entries(entries).some(
        ([name, spec]) =>
          typeof spec !== "string" ||
          (group !== "scripts" && !packageName(name)),
      )
    )
      invalid(`importer ${id} has invalid ${group}`);
  }
  if (
    raw.peerDependenciesMeta !== undefined &&
    (!object(raw.peerDependenciesMeta) ||
      Object.entries(raw.peerDependenciesMeta).some(
        ([name, meta]) =>
          !packageName(name) ||
          !object(meta) ||
          Object.keys(meta).some((key) => key !== "optional") ||
          (meta.optional !== undefined && typeof meta.optional !== "boolean"),
      ))
  )
    invalid(`importer ${id} has invalid peer metadata`);
  return raw as WorkspaceManifest;
}
function patternsOf(value: unknown): { include: string[]; exclude: string[] } {
  let list = value;
  if (object(value)) {
    if (Object.keys(value).some((key) => key !== "packages"))
      invalid("unsupported workspace settings");
    list = value.packages;
  }
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string"))
    invalid("workspaces must be patterns or a packages pattern list");
  const include: string[] = [],
    exclude: string[] = [];
  for (const item of list as string[]) {
    const negated = item.startsWith("!");
    const pattern = (negated ? item.slice(1) : item).replace(/\/$/, "");
    if (
      !pattern ||
      pattern.startsWith("/") ||
      pattern.includes("\\") ||
      pattern.includes("\0") ||
      pattern
        .split("/")
        .some((segment) => segment === "." || segment === "..") ||
      /^[A-Za-z]:/.test(pattern)
    )
      invalid("workspace pattern escapes its root");
    (negated ? exclude : include).push(pattern);
  }
  return { include, exclude };
}
/** Bounded traversal never follows directory symlinks, including matched ones. */
export async function discoverWorkspaces(
  rootDirectory: string,
  options: { maxDirectories?: number; maxEntries?: number } = {},
): Promise<WorkspaceProject> {
  const root = await realpath(rootDirectory);
  const rootManifest = await readManifest(root, ".");
  const projectContext = `project1_${sha512Hex(root).slice(0, 32)}`;
  const importer = (
    id: string,
    directory: string,
    manifest: WorkspaceManifest,
  ): WorkspaceImporter => ({
    id,
    directory,
    manifest,
    source: { kind: "live-directory", projectContext, importer: id },
  });
  const importers = [importer(".", root, rootManifest)];
  const maxDirectories = options.maxDirectories ?? 10000,
    maxEntries = options.maxEntries ?? 100000;
  if (
    ![maxDirectories, maxEntries].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    invalid("invalid workspace traversal limits");
  if (rootManifest.workspaces !== undefined) {
    const patterns = patternsOf(rootManifest.workspaces);
    const selected = (id: string) =>
      patterns.include.some((pattern) => path.matchesGlob(id, pattern)) &&
      !patterns.exclude.some((pattern) => path.matchesGlob(id, pattern));
    const pending = [{ id: "", directory: root }];
    let directories = 0,
      entries = 0;
    while (pending.length) {
      const current = pending.pop()!;
      if (++directories > maxDirectories)
        invalid("workspace directory limit exceeded");
      for await (const entry of await opendir(current.directory)) {
        if (++entries > maxEntries) invalid("workspace entry limit exceeded");
        if (
          ["node_modules", ".git", ".zyrk-local", ".zyrk"].includes(entry.name)
        )
          continue;
        const id = current.id ? `${current.id}/${entry.name}` : entry.name;
        const directory = path.join(root, ...id.split("/"));
        if (entry.isSymbolicLink()) {
          if (
            selected(id) ||
            patterns.include.some(
              (pattern) =>
                pattern.startsWith(`${id}/`) || pattern.startsWith("**"),
            )
          )
            invalid(`workspace ${id} is a symlink`);
          continue;
        }
        if (!entry.isDirectory()) continue;
        pending.push({ id, directory });
        if (selected(id)) {
          try {
            await lstat(path.join(directory, "package.json"));
          } catch (cause) {
            if (isErrno(cause, "ENOENT")) continue;
            throw cause;
          }
          importers.push(
            importer(id, directory, await readManifest(directory, id)),
          );
        }
      }
    }
  }
  importers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const names = new Set<string>();
  for (const member of importers)
    if (member.manifest.name) {
      if (names.has(member.manifest.name))
        invalid("duplicate workspace package name");
      names.add(member.manifest.name);
    }
  return {
    root,
    importers,
    manifestFingerprint: sha512Hex(
      canonicalJson(
        importers.map((member) => [
          member.id,
          member.manifest.name ?? null,
          member.manifest.version ?? null,
          manifestFingerprint({
            ...member.manifest,
            overrides:
              member.id === "." ? member.manifest.overrides : undefined,
          }),
        ]),
      ),
    ),
  };
}
export type WorkspaceDependency = {
  name: string;
  spec: string;
  kind: "prod" | "dev" | "optional" | "peer";
  peerOptional?: boolean;
  selection:
    | { kind: "local"; importer: string }
    | { kind: "registry"; requirement: ParsedRequirement };
};
export type WorkspaceImporterPlan = {
  importer: WorkspaceImporter;
  dependencies: WorkspaceDependency[];
};
/** Relationship plan only: local edges remain live and are never fed to registry fetchers. */
export function planWorkspaceDependencies(
  project: WorkspaceProject,
): WorkspaceImporterPlan[] {
  const byName = new Map(
    project.importers
      .filter((item) => item.id !== ".")
      .map((item) => [item.manifest.name!, item]),
  );
  return project.importers.map((importer) => {
    const dependencies: WorkspaceDependency[] = [];
    for (const [group, kind] of [
      ["dependencies", "prod"],
      ["devDependencies", "dev"],
      ["optionalDependencies", "optional"],
      ["peerDependencies", "peer"],
    ] as const) {
      for (const [name, spec] of Object.entries(
        importer.manifest[group] ?? {},
      ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (
          (kind === "prod" || kind === "dev") &&
          Object.hasOwn(importer.manifest.optionalDependencies ?? {}, name)
        )
          continue;
        let selection: WorkspaceDependency["selection"];
        if (spec.startsWith("workspace:")) {
          const local = byName.get(name);
          const range = spec.slice("workspace:".length);
          if (
            !local ||
            !range ||
            (!["*", "^", "~"].includes(range) &&
              (!validRange(range) ||
                !satisfies(local.manifest.version!, range)))
          )
            invalid(
              `importer ${importer.id} has an unsatisfied workspace reference ${name}`,
            );
          selection = { kind: "local", importer: local.id };
        } else if (spec.startsWith("file:") || spec.startsWith("link:")) {
          const relative = spec.slice(spec.indexOf(":") + 1);
          if (
            !relative ||
            relative.includes("\\") ||
            relative.includes("\0") ||
            path.isAbsolute(relative) ||
            /^[A-Za-z]:/.test(relative)
          )
            invalid(
              `importer ${importer.id} has an unsafe local reference ${name}`,
            );
          const destination = path.resolve(importer.directory, relative);
          const local = project.importers.find(
            (item) => item.directory === destination && item.id !== ".",
          );
          if (!local)
            invalid(
              `importer ${importer.id} local source for ${name} is not a discovered workspace package`,
            );
          selection = { kind: "local", importer: local.id };
        } else {
          const requirement = parseRequirement(name, spec);
          const local = byName.get(name);
          selection =
            local &&
            requirement.kind !== "alias" &&
            requirement.targetKind !== "tag" &&
            satisfies(local.manifest.version!, requirement.targetSpec)
              ? { kind: "local", importer: local.id }
              : { kind: "registry", requirement };
        }
        dependencies.push({
          name,
          spec,
          kind,
          ...(kind === "peer" &&
          importer.manifest.peerDependenciesMeta?.[name]?.optional
            ? { peerOptional: true }
            : {}),
          selection,
        });
      }
    }
    return { importer, dependencies };
  });
}
export function selectWorkspaceImporters(
  project: WorkspaceProject,
  selectors: readonly string[],
): WorkspaceImporter[] {
  if (!selectors.length) return [...project.importers];
  const chosen = new Set<WorkspaceImporter>();
  for (const selector of selectors) {
    const normalized = selector.replace(/^\.\//, "").replace(/\/$/, "");
    const matches = project.importers.filter(
      (item) => item.id === normalized || item.manifest.name === selector,
    );
    if (matches.length !== 1)
      invalid(
        "workspace selector must match one exact importer name or relative path",
      );
    chosen.add(matches[0]!);
  }
  return project.importers.filter((item) => chosen.has(item));
}
/** Reject candidate builds that can traverse old live workspace projections (§12.3.2). */
export function assertNoLiveSourceBuilds(options: {
  builds: readonly { key: string; name: string }[];
  edges: ReadonlyMap<string, readonly string[]>;
  liveSources: ReadonlyMap<string, string>;
}): void {
  for (const build of options.builds) {
    const pending = [build.key],
      seen = new Set<string>();
    while (pending.length) {
      const key = pending.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const importer = options.liveSources.get(key);
      if (importer !== undefined)
        throw new ZyrkError(
          "ZYRK_WORKSPACE_BUILD_CONTEXT_UNSUPPORTED",
          `Cannot build ${build.name}: its candidate closure reaches live workspace ${importer}.`,
          {
            remedy:
              "Use a validated candidate-workspace adapter before running this dependency lifecycle build.",
          },
        );
      const targets = options.edges.get(key);
      if (targets === undefined)
        throw new ZyrkError(
          "ZYRK_WORKSPACE_BUILD_CONTEXT_UNSUPPORTED",
          `Cannot verify the complete candidate closure for ${build.name}.`,
          {
            remedy:
              "Resolve every candidate dependency and peer before considering lifecycle execution.",
          },
        );
      for (const target of targets) pending.push(target);
    }
  }
}

/** Deterministic dependency-first ordering. No scripts run before cycle detection. */
export function workspaceScriptOrder(
  plan: readonly WorkspaceImporterPlan[],
): string[] {
  const remaining = new Map(
    plan.map((item) => [
      item.importer.id,
      new Set(
        item.dependencies
          .filter((edge) => edge.selection.kind === "local")
          .map((edge) =>
            edge.selection.kind === "local" ? edge.selection.importer : "",
          ),
      ),
    ]),
  );
  const ordered: string[] = [];
  while (remaining.size) {
    const ready = [...remaining]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort();
    if (!ready.length)
      throw new ZyrkError(
        "ZYRK_RESOLUTION_FAILED",
        "Cannot order workspace scripts because local dependencies contain a cycle.",
        {
          remedy:
            "Choose an explicit non-ordered invocation or remove the local dependency cycle before requesting dependency-ordered scripts.",
        },
      );
    for (const id of ready) {
      remaining.delete(id);
      ordered.push(id);
    }
    for (const deps of remaining.values())
      for (const id of ready) deps.delete(id);
  }
  return ordered;
}

/** Locate the authoritative workspace root when invoked inside an importer.
 * A nested unrelated package cannot borrow an ancestor workspace's policy.
 */
export async function findWorkspaceRoot(cwd: string): Promise<string | null> {
  const original = await realpath(cwd);
  let directory = original,
    nearest: string | undefined;
  for (;;) {
    const file = path.join(directory, "package.json");
    try {
      if (!(await lstat(file)).isFile())
        invalid("workspace boundary manifest must be a regular file");
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(file, "utf8"));
      } catch (cause) {
        if (cause instanceof SyntaxError)
          invalid("workspace boundary manifest is not valid JSON");
        throw cause;
      }
      if (!nearest) nearest = directory;
      if (object(raw) && raw.workspaces !== undefined) {
        const project = await discoverWorkspaces(directory);
        return project.importers.some(
          (importer) => importer.directory === nearest,
        )
          ? directory
          : null;
      }
    } catch (cause) {
      if (!isErrno(cause, "ENOENT")) throw cause;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
