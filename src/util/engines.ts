/** Normalize npm's historical engine arrays without weakening modern map checks. */
import { validRange } from "semver";

export function normalizeEngineConstraints(
  value: unknown,
  invalid: () => never,
): Record<string, string> {
  if (Array.isArray(value)) {
    const engines: Record<string, string> = {};
    for (const item of value) {
      const match =
        typeof item === "string"
          ? /^([a-z][a-z0-9._-]*)\s+(.+)$/.exec(item)
          : null;
      if (
        !match ||
        Object.hasOwn(engines, match[1]!) ||
        validRange(match[2]!) === null
      )
        return invalid();
      engines[match[1]!] = match[2]!;
    }
    return engines;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.values(value).some((item) => typeof item !== "string")
  )
    return invalid();
  return value as Record<string, string>;
}
