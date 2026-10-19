/**
 * Project scaffolding: `zyrk create <name>[@spec] [args...]`.
 *
 * The initializer mapping mirrors npm exactly (verified against npm's own
 * `init` command): `foo` runs `create-foo`, `@scope/bar` runs
 * `@scope/create-bar`, and a bare `@scope` runs `@scope/create`, each with
 * the requested version or `*` when none was given. An already-prefixed
 * `create-foo` is used as-is. Initializers use writable private temporary
 * closures; trust policy and cleanup match dlx. The Next adapter installs
 * generated dependencies natively after the initializer's skip-install step.
 */

import { runNextInitializer } from "./next.ts";
import npa from "npm-package-arg";
import type { InstallOptions } from "../install/run.ts";
import { ZyrkError } from "../errors.ts";
import { runInitializer, type DlxOptions, type DlxResult } from "./run.ts";

export type CreateOptions = Omit<DlxOptions, "spec"> & {
  /** Initializer as typed: `next-app`, `vite@^5`, `@scope`, `@scope/kit@beta`. */
  input: string;
  onInstallProgress?: InstallOptions["onProgress"];
};

/**
 * Map an initializer to its starter package specifier. Throws ZYRK_USAGE
 * for non-registry inputs (Git/hosted initializers are deferred along with
 * every other non-registry protocol).
 */
export function starterSpecFor(input: string): string {
  const bareScope = /^@([^/]+?)(@([^/]+))?$/.exec(input);
  if (bareScope !== null) {
    const scope = bareScope[1] ?? "";
    const version = bareScope[3];
    if (scope === "") throw usage(input);
    return version === undefined
      ? `@${scope}/create`
      : `@${scope}/create@${version}`;
  }
  let parsed: { name: unknown; rawSpec: unknown; registry: unknown };
  try {
    parsed = npa(input);
  } catch (error) {
    throw usage(input, error);
  }
  if (
    typeof parsed.name !== "string" ||
    parsed.name === "" ||
    typeof parsed.rawSpec !== "string" ||
    parsed.registry !== true
  ) {
    throw usage(input);
  }
  const unscoped = parsed.name.replace(/^@[^/]+\//, "");
  const packageName = unscoped.startsWith("create-")
    ? parsed.name
    : parsed.name.replace(/^(@[^/]+\/)?/, "$1create-");
  return `${packageName}@${parsed.rawSpec}`;
}

function usage(input: string, cause?: unknown): ZyrkError {
  return new ZyrkError("ZYRK_USAGE", `unrecognized initializer: ${input}.`, {
    detail: { input },
    remedy:
      "use a registry package name with an optional @version, @range, or @tag",
    ...(cause === undefined ? {} : { cause }),
  });
}

export async function runCreate(options: CreateOptions): Promise<DlxResult> {
  const { input, ...rest } = options;
  const spec = starterSpecFor(input);
  return spec.startsWith("create-next-app@")
    ? runNextInitializer({ ...rest, spec })
    : runInitializer({ ...rest, spec });
}
