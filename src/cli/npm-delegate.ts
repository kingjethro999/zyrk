/**
 * Explicit delegation of registry write-side and account commands to the
 * user's own npm CLI (D-3, founder direction).
 *
 * zyrk does not reimplement publishing or registry authentication: it
 * verifies nothing about the arguments, forwards them verbatim to `npm`,
 * and propagates the child exit code or signal unchanged. The environment
 * passes through untouched — zyrk injects no credentials, tokens, or ZYRK_*
 * variables, and npm authenticates exactly as when run directly. stdio is
 * inherited so interactive flows (`login`) and scripts parsing stdout
 * (`pack --json`) behave identically. A one-line disclosure goes to stderr
 * so npm's stdout stays clean.
 *
 * Delegation never touches the zyrk store, lockfile, or projection, never
 * runs package code itself, and never selects versions: those commands
 * operate outside zyrk's dependency management. Global installs are never
 * delegated (F-018); see parse.ts.
 */

import { spawn } from "node:child_process";
import { ZyrkError } from "../errors.ts";
import { closeCode } from "../util/proc.ts";

/** Delegated command, its aliases collapsed, plus help text. */
const DELEGATED_COMMANDS: ReadonlyArray<readonly [readonly string[], string]> =
  [
    [["publish"], "Publish the current package to the registry (via npm)."],
    [["unpublish"], "Remove a published version from the registry (via npm)."],
    [["access"], "Manage package access and visibility (via npm)."],
    [["deprecate"], "Mark a published version as deprecated (via npm)."],
    [["dist-tag"], "Manage distribution tags (via npm)."],
    [["owner"], "Manage package owners (via npm)."],
    [["token"], "Manage registry authentication tokens (via npm)."],
    [["adduser", "login"], "Authenticate with a registry (via npm)."],
    [["logout"], "Remove registry authentication (via npm)."],
    [["whoami"], "Show the authenticated registry username (via npm)."],
    [["ping"], "Check registry authentication and reachability (via npm)."],
    [["pack"], "Create a tarball from the current package (via npm)."],
  ];

export const DELEGATED_COMMAND_NAMES: ReadonlySet<string> = new Set(
  DELEGATED_COMMANDS.flatMap(([names]) => names),
);

export function isDelegatedCommand(command: string): boolean {
  return DELEGATED_COMMAND_NAMES.has(command);
}

export function delegatedHelpLines(): string[] {
  return DELEGATED_COMMANDS.map(
    ([names, description]) =>
      `  ${names.join(", ").padEnd(22, " ")}${description}`,
  );
}

export type DelegateOptions = {
  command: string;
  /** Raw tokens after the command, verbatim (may include --json, --, -g). */
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  stderr: { write(chunk: string): unknown };
};

/**
 * Exec `npm <command> <args...>` with inherited stdio. Resolves with the
 * child exit code, or 128 plus the signal number when signaled (the shell
 * convention), so callers observe the same termination. Rejects with
 * ZYRK_NPM_UNAVAILABLE when npm cannot be launched.
 */
export async function delegateToNpm(options: DelegateOptions): Promise<number> {
  options.stderr.write(
    `zyrk: delegating \`zyrk ${options.command}\` to npm; zyrk does not implement publishing or registry authentication.\n`,
  );
  return new Promise((resolve, reject) => {
    const child = spawn("npm", [options.command, ...options.args], {
      env: options.env,
      stdio: "inherit",
    });
    child.on("error", (error) => {
      reject(
        new ZyrkError(
          "ZYRK_NPM_UNAVAILABLE",
          "zyrk could not launch npm for an explicitly delegated command.",
          {
            detail: { command: options.command },
            remedy:
              "Install Node.js with npm on PATH, or run the npm command directly.",
            cause: error,
          },
        ),
      );
    });
    child.on("close", (code, signal) => {
      resolve(closeCode(code, signal));
    });
  });
}
