/**
 * Requirement parsing through npm-package-arg (SPEC 9.2).
 *
 * Supported: exact versions, semver ranges (bare names behave as `*`),
 * dist-tags, scoped names, and npm aliases. Remote tarballs, Git sources,
 * and local file/directory specs are deferred by the spec and fail here
 * explicitly — they are never handed to a tool that might run scripts.
 */

import npa from "npm-package-arg";
import { ZyrkError } from "../errors.ts";

export type RequirementKind = "exact" | "range" | "tag" | "alias";

export type ParsedRequirement = {
  /** Edge name as it appears in `node_modules` (alias-aware). */
  edgeName: string;
  /** Registry package name (the alias target for alias specs). */
  realName: string;
  kind: RequirementKind;
  /** Version, range, or tag for the real package. */
  targetSpec: string;
  /** Effective selection kind (aliases resolve through to it). */
  targetKind: "exact" | "range" | "tag";
};

function unsupported(what: string, spec: string): ZyrkError {
  return new ZyrkError(
    "ZYRK_RESOLUTION_FAILED",
    `unsupported dependency protocol in "${spec}" (${what})`,
    {
      detail: { spec },
      remedy:
        "remote tarballs, Git dependencies, and local archives are deferred; use a registry version, range, tag, or npm alias",
    },
  );
}

/**
 * Parse one dependency entry. `edgeName` is the key from the requiring
 * manifest; `spec` is its raw value ("" selects the default tag).
 */
export function parseRequirement(
  edgeName: string,
  spec: string,
): ParsedRequirement {
  let parsed: ReturnType<typeof npa>;
  try {
    parsed = npa(spec === "" ? edgeName : `${edgeName}@${spec}`);
  } catch (error) {
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `invalid requirement "${edgeName}@${spec}"`,
      {
        detail: { edgeName, spec },
        remedy: "use a valid npm package specifier",
        cause: error,
      },
    );
  }
  if (parsed.name !== edgeName) {
    throw new ZyrkError(
      "ZYRK_INTERNAL",
      `requirement name mismatch: ${edgeName} parsed as ${parsed.name}`,
      {
        detail: { edgeName, parsed: parsed.name },
      },
    );
  }
  switch (parsed.type) {
    case "version": {
      if (parsed.fetchSpec === null) {
        throw new ZyrkError(
          "ZYRK_INTERNAL",
          `no fetch spec in "${edgeName}@${spec}"`,
          {
            detail: { edgeName, spec },
          },
        );
      }
      return {
        edgeName,
        realName: parsed.name,
        kind: "exact",
        targetSpec: parsed.fetchSpec,
        targetKind: "exact",
      };
    }
    case "range":
    case "tag": {
      if (parsed.fetchSpec === null) {
        throw new ZyrkError(
          "ZYRK_INTERNAL",
          `no fetch spec in "${edgeName}@${spec}"`,
          {
            detail: { edgeName, spec },
          },
        );
      }
      return {
        edgeName,
        realName: parsed.name,
        kind: parsed.type,
        targetSpec: parsed.fetchSpec,
        targetKind: parsed.type,
      };
    }
    case "alias": {
      const sub = parsed.subSpec;
      if (sub === undefined) {
        throw new ZyrkError(
          "ZYRK_INTERNAL",
          `alias "${edgeName}@${spec}" has no target`,
          {
            detail: { edgeName, spec },
          },
        );
      }
      const inner = parseRequirement(sub.name, sub.fetchSpec ?? "");
      return {
        edgeName,
        realName: inner.realName,
        kind: "alias",
        targetSpec: inner.targetSpec,
        targetKind: inner.targetKind,
      };
    }
    default:
      throw unsupported(parsed.type, `${edgeName}@${spec}`);
  }
}
