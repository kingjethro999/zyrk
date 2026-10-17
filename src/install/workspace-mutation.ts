/** In-memory importer edits; publication owns all manifest writes. */
import npa from "npm-package-arg";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import type { InstallOptions } from "./run.ts";
import type { WorkspaceProject } from "./workspaces.ts";
import type { WorkspaceGraph } from "./workspace-graph.ts";
import { manifestFingerprint } from "../lockfile/fingerprints.ts";
import { canonicalJson } from "../util/json.ts";
import { sha512Hex } from "../util/hash.ts";
import { packageName } from "./lock.ts";
import { parseRequirement } from "../resolve/spec.ts";
import { ZyrkError } from "../errors.ts";
const usage = (why: string): never => {
  throw new ZyrkError(
    "ZYRK_USAGE",
    `Cannot edit workspace dependencies (${why}).`,
    {
      remedy:
        "Select an importer and valid direct registry or workspace dependency names.",
    },
  );
};
export function refreshWorkspaceFingerprint(project: WorkspaceProject): void {
  project.manifestFingerprint = sha512Hex(
    canonicalJson(
      project.importers.map((member) => [
        member.id,
        member.manifest.name ?? null,
        member.manifest.version ?? null,
        manifestFingerprint(member.manifest),
      ]),
    ),
  );
}
export async function prepareWorkspaceMutation(
  project: WorkspaceProject,
  options: InstallOptions,
): Promise<{
  fresh: Set<string>;
  finish(graph: WorkspaceGraph): void;
  changed: boolean;
}> {
  const cwd = await realpath(options.projectDir),
    importer = [...project.importers]
      .sort((a, b) => b.directory.length - a.directory.length)
      .find(
        (i) => cwd === i.directory || cwd.startsWith(i.directory + path.sep),
      );
  if (!importer) usage("invocation does not belong to an importer");
  const manifest = importer!.manifest,
    groups = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ] as const;
  const all = () => ({
    ...manifest.devDependencies,
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  });
  const specs = options.specs ?? [],
    mutation = options.mutation,
    fresh = new Set<string>(),
    added = new Map<
      string,
      { group: (typeof groups)[number]; save: boolean; alias?: string }
    >();
  if ((specs.length || mutation) && (options.frozen || options.offline))
    usage("mutation cannot be combined with frozen or offline install");
  for (const name of mutation?.remove ?? []) {
    if (!packageName(name)) usage("invalid removal name");
    let found = false;
    for (const group of [...groups, "peerDependencies"] as const) {
      if (manifest[group]?.[name] !== undefined) {
        delete manifest[group]![name];
        found = true;
      }
    }
    if (!found) usage("removed package is not a direct dependency");
  }
  const updates = new Set(
    mutation?.update?.length ? mutation.update : Object.keys(all()),
  );
  if (mutation?.update !== undefined)
    for (const name of updates) {
      const spec = all()[name];
      if (spec === undefined)
        usage("updated package is not a direct dependency");
      fresh.add(`${importer!.id}\0${name}`);
      if (mutation.latest) {
        if (
          spec!.startsWith("workspace:") ||
          spec!.startsWith("file:") ||
          spec!.startsWith("link:")
        )
          continue;
        const parsed = parseRequirement(name, spec!);
        for (const group of groups)
          if (manifest[group]?.[name] !== undefined) {
            manifest[group]![name] =
              parsed.kind === "alias"
                ? `npm:${parsed.realName}@latest`
                : "latest";
            added.set(name, {
              group,
              save: true,
              ...(parsed.kind === "alias" ? { alias: parsed.realName } : {}),
            });
          }
      }
    }
  for (const spec of specs) {
    const workspaceAt = spec.lastIndexOf("@workspace:");
    let name: string,
      requested: string,
      save = false,
      alias: string | undefined;
    if (workspaceAt > 0) {
      name = spec.slice(0, workspaceAt);
      requested = spec.slice(workspaceAt + 1);
      if (!packageName(name)) usage("invalid workspace package");
    } else {
      let parsed: ReturnType<typeof npa>;
      try {
        parsed = npa(spec);
      } catch {
        usage("invalid package specification");
      }
      if (
        !parsed!.name ||
        !packageName(parsed!.name) ||
        !["version", "range", "tag", "alias"].includes(parsed!.type)
      )
        usage("unsupported source protocol");
      name = parsed!.name!;
      requested =
        parsed!.rawSpec === "" || parsed!.rawSpec === "*"
          ? "latest"
          : parsed!.rawSpec;
      save =
        parsed!.type === "version" ||
        parsed!.type === "tag" ||
        requested === "latest";
      if (parsed!.type === "alias") {
        const requirement = parseRequirement(name, requested);
        alias = requirement.realName;
      }
    }
    const group = options.saveOptional
      ? "optionalDependencies"
      : options.saveDev
        ? "devDependencies"
        : "dependencies";
    manifest[group] = { ...manifest[group], [name]: requested };
    for (const other of groups)
      if (other !== group && manifest[other]) delete manifest[other]![name];
    fresh.add(`${importer!.id}\0${name}`);
    added.set(name, { group, save, ...(alias ? { alias } : {}) });
  }
  refreshWorkspaceFingerprint(project);
  return {
    fresh,
    changed: specs.length > 0 || mutation !== undefined,
    finish(graph) {
      const node = graph.nodes.find(
        (n) => n.key === graph.importers[importer!.id],
      );
      if (!node) usage("selected importer disappeared");
      for (const [name, entry] of added) {
        if (!entry.save) continue;
        const target = node!.edges.find((e) => e.name === name)?.target,
          selected = graph.nodes.find((n) => n.key === target);
        if (!selected) usage("selected dependency disappeared");
        const range = options.saveExact
          ? selected!.version
          : `^${selected!.version}`;
        manifest[entry.group]![name] = entry.alias
          ? `npm:${entry.alias}@${range}`
          : range;
      }
      refreshWorkspaceFingerprint(project);
    },
  };
}
