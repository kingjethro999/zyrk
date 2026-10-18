/** Credential-free routing captured with the exact installed generation. */
import { cleanUrl, lockMismatch } from "./lock.ts";
export type InstalledRegistryConfig = {
  registry: string;
  registries?: Readonly<Record<string, string>>;
};
export function installedRegistryConfig(
  state: Record<string, unknown>,
  nodes: readonly { name: string; origin: string }[],
): InstalledRegistryConfig {
  const object = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === "object" && !Array.isArray(x);
  const raw = state.registryConfig;
  if (raw === undefined) {
    const origins = new Set(nodes.map((n) => n.origin));
    if (origins.size !== 1)
      throw lockMismatch(
        "legacy installed state has no exact registry routing",
      );
    return { registry: [...origins][0]! };
  }
  if (
    !object(raw) ||
    Object.keys(raw).some((k) => !["registry", "registries"].includes(k)) ||
    typeof raw.registry !== "string" ||
    !cleanUrl(raw.registry) ||
    !object(raw.registries) ||
    Object.entries(raw.registries).some(
      ([scope, url]) =>
        !/^@[a-z0-9][a-z0-9._-]*$/.test(scope) ||
        typeof url !== "string" ||
        !cleanUrl(url),
    )
  )
    throw lockMismatch("installed registry routing is malformed");
  const registries = raw.registries as Record<string, string>;
  for (const node of nodes) {
    const expected = node.name.startsWith("@")
      ? (registries[node.name.slice(0, node.name.indexOf("/"))] ?? raw.registry)
      : raw.registry;
    if (node.origin !== expected)
      throw lockMismatch(
        "installed registry routing disagrees with selected sources",
      );
  }
  return { registry: raw.registry, registries };
}
