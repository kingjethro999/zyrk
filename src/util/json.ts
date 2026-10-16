/**
 * Canonical JSON for hashing: object keys sorted, no whitespace, no
 * `undefined`, numbers restricted to what JSON can represent deterministically.
 *
 * Context IDs, manifest hashes, and lockfile fingerprints are byte-identical
 * only if their serialization is deterministic (SPEC 9.6, 14.2).
 */

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  writeCanonical(value, out, 0);
  return out.join("");
}

const MAX_CANONICAL_DEPTH = 200;

function writeCanonical(value: unknown, out: string[], depth: number): void {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new TypeError(`canonicalJson: value nested deeper than ${MAX_CANONICAL_DEPTH}`);
  }
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonicalJson: non-finite number");
      }
      out.push(JSON.stringify(value));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "object": {
      if (Array.isArray(value)) {
        out.push("[");
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(",");
          writeCanonical(value[i], out, depth + 1);
        }
        out.push("]");
        return;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      out.push("{");
      let first = true;
      for (const [key, entryValue] of entries) {
        if (entryValue === undefined) {
          throw new TypeError(`canonicalJson: undefined value at key ${JSON.stringify(key)}`);
        }
        if (!first) out.push(",");
        first = false;
        out.push(JSON.stringify(key), ":");
        writeCanonical(entryValue, out, depth + 1);
      }
      out.push("}");
      return;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}

/**
 * JSON.parse with a typed failure. Callers pass the stable error code that
 * fits the document being parsed.
 */
export function parseJsonOrThrow(
  text: string,
  what: string,
  onInvalid: (message: string, cause: unknown) => Error,
): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw onInvalid(`${what} is not valid JSON`, cause);
  }
}
