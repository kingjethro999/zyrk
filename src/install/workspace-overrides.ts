/** Live importers have one dependency graph; compatible scopes may narrow it. */
import { satisfies } from "semver";
import {
  createRootOverrides,
  type OverrideContext,
} from "../resolve/overrides.ts";
import { parseRequirement } from "../resolve/spec.ts";
import {
  planWorkspaceDependencies,
  type WorkspaceProject,
} from "./workspaces.ts";
import { lockMismatch } from "./lock.ts";
function ancestor(outer: OverrideContext, inner: OverrideContext): boolean {
  for (
    let current: OverrideContext | undefined = inner;
    current;
    current = current.parent
  )
    if (current === outer) return true;
  return false;
}
export function workspaceOverrides(project: WorkspaceProject) {
  const policy = createRootOverrides(
    project.importers.find((i) => i.id === ".")!.manifest,
  );
  const contexts = new Map<string, OverrideContext>();
  const plans = planWorkspaceDependencies(project);
  for (const importer of project.importers)
    contexts.set(
      `workspace:${importer.id}`,
      importer.id === "."
        ? policy.root
        : policy.select(
            policy.root,
            importer.manifest.name!,
            importer.manifest.version!,
          ).context,
    );
  for (let round = 0; round <= 128; round++) {
    let changed = false;
    for (const plan of plans) {
      const parent = contexts.get(`workspace:${plan.importer.id}`)!;
      for (const edge of plan.dependencies) {
        const selected = policy.select(parent, edge.name, edge.spec);
        const localId =
          edge.selection.kind === "local" ? edge.selection.importer : undefined;
        let local = project.importers.find((i) => i.id === localId);
        if (selected.spec !== edge.spec) {
          const requirement = parseRequirement(edge.name, selected.spec);
          local = project.importers.find(
            (i) =>
              i.id !== "." &&
              i.manifest.name === requirement.realName &&
              requirement.kind !== "alias" &&
              requirement.targetKind !== "tag" &&
              satisfies(i.manifest.version!, requirement.targetSpec),
          );
        }
        if (!local) continue;
        const key = `workspace:${local.id}`,
          current = contexts.get(key)!;
        if (ancestor(current, selected.context)) {
          if (current !== selected.context) {
            contexts.set(key, selected.context);
            changed = true;
          }
        } else if (!ancestor(selected.context, current)) {
          throw lockMismatch(
            "one live workspace cannot represent incompatible scoped override contexts",
          );
        }
      }
    }
    if (!changed) return { policy, contexts };
  }
  throw lockMismatch("workspace override propagation resource limit exceeded");
}
/** Internal signal: restart pure planning before any fetch/publication mutation. */
export class WorkspaceOverrideRestart extends Error {}
export function refineWorkspaceOverride(
  contexts: Map<string, OverrideContext>,
  key: string,
  incoming: OverrideContext,
): void {
  const current = contexts.get(key)!;
  if (current === incoming || ancestor(incoming, current)) return;
  if (!ancestor(current, incoming))
    throw lockMismatch(
      "one live workspace cannot represent incompatible scoped override contexts",
    );
  contexts.set(key, incoming);
  throw new WorkspaceOverrideRestart();
}
