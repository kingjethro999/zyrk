/**
 * Dependency update/install dry-run planning and diff explanation (§CLI-06).
 * Computes direct and transitive changes between the current and resolved state
 * with zero disk mutations or script executions.
 */

export type DependencyPlanItem = {
  name: string;
  from?: string;
  to?: string;
  group?:
    | "dependencies"
    | "devDependencies"
    | "optionalDependencies"
    | "peerDependencies";
};

export type PackagePlanDiff = {
  name: string;
  from?: string;
  to?: string;
};

export type DependencyPlan = {
  direct: {
    added: DependencyPlanItem[];
    updated: DependencyPlanItem[];
    removed: DependencyPlanItem[];
  };
  packages: {
    added: PackagePlanDiff[];
    updated: PackagePlanDiff[];
    removed: PackagePlanDiff[];
  };
};

type ManifestDecl = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
};

const GROUPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Computes the diff between original manifest and proposed manifest. */
export function computeDirectPlan(
  original: ManifestDecl,
  proposed: ManifestDecl,
): DependencyPlan["direct"] {
  const added: DependencyPlanItem[] = [];
  const updated: DependencyPlanItem[] = [];
  const removed: DependencyPlanItem[] = [];

  for (const group of GROUPS) {
    const origGroup = (original[group] ?? {}) as Record<string, string>;
    const propGroup = (proposed[group] ?? {}) as Record<string, string>;

    for (const [name, to] of Object.entries(propGroup)) {
      if (origGroup[name] === undefined) {
        added.push({ name, to, group });
      } else if (origGroup[name] !== to) {
        updated.push({ name, from: origGroup[name], to, group });
      }
    }

    for (const [name, from] of Object.entries(origGroup)) {
      if (propGroup[name] === undefined) {
        removed.push({ name, from, group });
      }
    }
  }

  added.sort((a, b) => a.name.localeCompare(b.name));
  updated.sort((a, b) => a.name.localeCompare(b.name));
  removed.sort((a, b) => a.name.localeCompare(b.name));

  return { added, updated, removed };
}

/** Computes the diff between prior resolved graph nodes and new graph nodes. */
export function computePackagesPlan(
  priorNodes: ReadonlyArray<{ name: string; version: string }>,
  resolvedNodes: ReadonlyArray<{ name: string; version: string }>,
): DependencyPlan["packages"] {
  const priorMap = new Map<string, string>();
  for (const node of priorNodes) {
    priorMap.set(node.name, node.version);
  }

  const resolvedMap = new Map<string, string>();
  for (const node of resolvedNodes) {
    resolvedMap.set(node.name, node.version);
  }

  const added: PackagePlanDiff[] = [];
  const updated: PackagePlanDiff[] = [];
  const removed: PackagePlanDiff[] = [];

  for (const [name, to] of resolvedMap) {
    const from = priorMap.get(name);
    if (from === undefined) {
      added.push({ name, to });
    } else if (from !== to) {
      updated.push({ name, from, to });
    }
  }

  for (const [name, from] of priorMap) {
    if (!resolvedMap.has(name)) {
      removed.push({ name, from });
    }
  }

  added.sort((a, b) => a.name.localeCompare(b.name));
  updated.sort((a, b) => a.name.localeCompare(b.name));
  removed.sort((a, b) => a.name.localeCompare(b.name));

  return { added, updated, removed };
}

/** Computes the combined direct manifest and resolved package diff. */
export function computeDependencyPlan(options: {
  originalManifest: ManifestDecl;
  proposedManifest: ManifestDecl;
  priorNodes?: ReadonlyArray<{ name: string; version: string }>;
  resolvedNodes: ReadonlyArray<{ name: string; version: string }>;
}): DependencyPlan {
  return {
    direct: computeDirectPlan(
      options.originalManifest,
      options.proposedManifest,
    ),
    packages: computePackagesPlan(
      options.priorNodes ?? [],
      options.resolvedNodes,
    ),
  };
}

/** Renders a readable human terminal summary of the dependency plan. */
export function renderPlanSummary(
  plan: DependencyPlan,
  options: { color?: boolean } = {},
): string {
  const color = options.color !== false;
  const dim = (v: string) => (color ? `\u001b[2m${v}\u001b[0m` : v);
  const bold = (v: string) => (color ? `\u001b[1m${v}\u001b[0m` : v);
  const green = (v: string) => (color ? `\u001b[32m${v}\u001b[0m` : v);
  const yellow = (v: string) => (color ? `\u001b[33m${v}\u001b[0m` : v);
  const red = (v: string) => (color ? `\u001b[31m${v}\u001b[0m` : v);

  const lines: string[] = [];
  lines.push(
    bold("Dependency change plan") +
      dim(" (dry run, no files modified)") +
      "\n",
  );

  const totalDirect =
    plan.direct.added.length +
    plan.direct.updated.length +
    plan.direct.removed.length;
  const totalPkgs =
    plan.packages.added.length +
    plan.packages.updated.length +
    plan.packages.removed.length;

  if (totalDirect === 0 && totalPkgs === 0) {
    lines.push(
      "No dependency changes proposed. All packages match the requested specification.\n",
    );
    return lines.join("\n");
  }

  if (totalDirect > 0) {
    lines.push(bold("Direct dependencies:"));
    for (const item of plan.direct.added) {
      lines.push(
        `  ${green("+")} ${item.name}@${item.to} ${dim(`(${item.group})`)}`,
      );
    }
    for (const item of plan.direct.updated) {
      lines.push(
        `  ${yellow("~")} ${item.name}: ${dim(item.from ?? "")} -> ${bold(item.to ?? "")} ${dim(`(${item.group})`)}`,
      );
    }
    for (const item of plan.direct.removed) {
      lines.push(`  ${red("-")} ${item.name} ${dim(`(${item.group})`)}`);
    }
    lines.push("");
  }

  if (totalPkgs > 0) {
    lines.push(bold("Package resolutions:"));
    for (const item of plan.packages.added) {
      lines.push(`  ${green("+")} ${item.name}@${item.to}`);
    }
    for (const item of plan.packages.updated) {
      lines.push(
        `  ${yellow("~")} ${item.name}: ${dim(item.from ?? "")} -> ${bold(item.to ?? "")}`,
      );
    }
    for (const item of plan.packages.removed) {
      lines.push(`  ${red("-")} ${item.name}@${item.from}`);
    }
    lines.push("");
  }

  const parts: string[] = [];
  if (plan.packages.added.length > 0)
    parts.push(`${plan.packages.added.length} to add`);
  if (plan.packages.updated.length > 0)
    parts.push(`${plan.packages.updated.length} to update`);
  if (plan.packages.removed.length > 0)
    parts.push(`${plan.packages.removed.length} to remove`);

  lines.push(
    `Summary: ${parts.length ? parts.join(", ") : "no package changes"}.`,
    dim("Run without --plan to apply these changes.\n"),
  );

  return lines.join("\n");
}
