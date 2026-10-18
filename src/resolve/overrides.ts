/** Root npm override policy. Parsing never fetches metadata or executes code. */
import npa from "npm-package-arg";
import { intersects, validRange } from "semver";
import { ZyrkError } from "../errors.ts";
import type { ManifestDeclaration } from "../lockfile/fingerprints.ts";
import { parseRequirement } from "./spec.ts";
import { packageName } from "../install/lock.ts";
export type OverrideContext = {
  readonly id: string;
  readonly name?: string;
  readonly range?: string;
  readonly value?: string;
  readonly parent?: OverrideContext;
  readonly children: readonly OverrideContext[];
};
function invalid(reason: string): never {
  throw new ZyrkError(
    "ZYRK_MANIFEST_INVALID",
    `Cannot apply root dependency overrides (${reason}).`,
    {
      remedy:
        "Use root registry override rules, valid nested selectors and references to declared direct dependencies.",
    },
  );
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export class OverridePolicy {
  readonly root: OverrideContext;
  constructor(manifest: ManifestDeclaration) {
    const raw = manifest.overrides;
    if (raw !== undefined && !object(raw)) invalid("policy must be an object");
    // npm's $reference lookup checks dev before optional, production and peer.
    const references = {
      ...manifest.peerDependencies,
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.devDependencies,
    };
    let count = 0;
    const build = (
      value: unknown,
      key: string | undefined,
      parent?: OverrideContext,
      depth = 0,
    ): OverrideContext => {
      if (++count > 10000 || depth > 128)
        invalid("policy resource limit exceeded");
      if (typeof value === "string") value = { ".": value };
      if (!object(value)) invalid("each rule must be a string or object");
      let name: string | undefined,
        range: string | undefined,
        replacement: string | undefined;
      if (key !== undefined) {
        try {
          const spec = npa(key);
          name = spec.name;
          range = spec.rawSpec || "*";
          if (
            !name ||
            !packageName(name) ||
            !["version", "range"].includes(spec.type) ||
            validRange(range) === null
          )
            invalid(
              "selector must be a package name and optional semver range",
            );
        } catch {
          invalid("invalid registry override selector");
        }
        const self = value["."];
        if (self !== undefined && typeof self !== "string")
          invalid("self replacement must be a string");
        replacement = self === undefined ? range! : self || "*";
        if (replacement.startsWith("$")) {
          const reference = replacement.slice(1);
          if (!packageName(reference) || !Object.hasOwn(references, reference))
            invalid("unknown direct dependency reference");
          replacement = references[reference]!;
        }
        try {
          parseRequirement(name!, replacement);
        } catch {
          invalid("replacement must use a supported registry source");
        }
      } else if (Object.hasOwn(value, "."))
        invalid("root cannot contain a self replacement");
      const children: OverrideContext[] = [];
      const context: OverrideContext = {
        id: parent ? `${parent.id}/${key!}` : "",
        ...(name ? { name } : {}),
        ...(range ? { range } : {}),
        ...(replacement !== undefined ? { value: replacement } : {}),
        ...(parent ? { parent } : {}),
        children,
      };
      for (const [child, spec] of Object.entries(value))
        if (child !== ".")
          children.push(build(spec, child, context, depth + 1));
      return context;
    };
    this.root = build(raw ?? {}, undefined);
    // Legality applies to the edge selected by zyrk's install groups, which
    // prioritize optional > production > development, independently of refs.
    const direct = {
      ...manifest.peerDependencies,
      ...manifest.devDependencies,
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    };
    for (const [name, spec] of Object.entries(direct)) {
      const selected = this.select(this.root, name, spec);
      if (selected.spec !== spec)
        invalid("override conflicts with an exact direct dependency spec");
    }
  }
  select(
    context: OverrideContext,
    name: string,
    spec: string,
  ): { spec: string; context: OverrideContext } {
    const seen = new Set<string>();
    for (
      let ancestor: OverrideContext | undefined = context;
      ancestor;
      ancestor = ancestor.parent
    ) {
      const rules = [
        ...ancestor.children,
        ...(ancestor.parent ? [ancestor] : []),
      ];
      for (const rule of rules) {
        const key = `${rule.name!}@${rule.range!}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (rule.name !== name) continue;
        let matches = rule.range === "*";
        if (!matches) {
          try {
            const workspaceRange = spec.startsWith("workspace:")
              ? spec.slice(10)
              : undefined;
            const requested = parseRequirement(
              name,
              workspaceRange === undefined
                ? spec
                : ["*", "^", "~"].includes(workspaceRange)
                  ? "*"
                  : workspaceRange,
            );
            matches =
              requested.targetKind === "tag" ||
              intersects(requested.targetSpec, rule.range!);
          } catch {
            matches = spec.startsWith("file:") || spec.startsWith("link:");
          }
        }
        if (matches)
          return {
            spec: rule.value === "*" ? spec : rule.value!,
            context: rule,
          };
      }
    }
    return { spec, context };
  }
}
export function createRootOverrides(
  manifest: ManifestDeclaration,
): OverridePolicy {
  return new OverridePolicy(manifest);
}
