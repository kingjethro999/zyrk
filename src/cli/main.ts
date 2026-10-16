/**
 * snpm command dispatch (SPEC 15).
 *
 * This is the roadmap skeleton, not the implementation: every listed command
 * dispatches today, but only `--help`, `--version`, the global-install
 * rejection, and (later) explicit npm delegation do anything yet. Native
 * dependency commands fail with SNPM_NOT_IMPLEMENTED rather than pretending
 * to work; unknown commands fail with SNPM_USAGE and the help text.
 * Nothing here launches a subprocess: rejection happens before resolution,
 * downloads, lifecycle execution, project/store mutation, or any child
 * process (SPEC 15.3.1).
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exitCodeFor, SnpmError, toSnpmError } from "../errors.ts";
import {
  delegateToNpm,
  delegatedHelpLines,
  isDelegatedCommand,
} from "./npm-delegate.ts";
import { isGlobalInstallRequest, parseArgs, type ParsedArgs } from "./parse.ts";

export const CLI_JSON_SCHEMA_VERSION = 1;

/** Spec-defined dependency commands (SPEC 15.1-15.2, fetch, docker). */
const NATIVE_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["install, i", "Install the locked or newly resolved graph."],
  ["fetch", "Fetch and verify a locked source closure."],
  ["add", "Add dependencies transactionally."],
  ["remove", "Remove direct dependencies and refresh the closure."],
  ["update", "Update within allowed ranges."],
  ["run", "Run a project script with local binary paths."],
  ["exec", "Run an installed executable (never fetches)."],
  ["dlx", "Explicitly fetch and run a temporary tool environment."],
  ["list, why", "Show the installed graph / why a dependency is selected."],
  ["doctor", "Diagnose filesystem, links, policy, install-state issues."],
  ["approve-builds, rebuild", "Review script permissions / rebuild."],
  ["audit", "Report vulnerabilities under the configured privacy policy."],
  ["patch, patch-commit", "Create a private edit area / emit a patch."],
  ["store", "Inspect, verify, collect, and retain the store."],
  ["projects", "List registrations / drop a retention root."],
  ["repair", "Reconstruct the project from verified locked inputs."],
  ["import", "Convert supported npm lock information."],
  ["deploy", "Create self-contained production output."],
  ["docker", "Generate, build, and start the Docker setup."],
];

const KNOWN_COMMANDS = new Set<string>();
for (const [names] of NATIVE_COMMANDS) {
  for (const name of names.split(", ")) KNOWN_COMMANDS.add(name);
}

export function helpText(version: string): string {
  const lines = [
    `snpm v${version} — one verified store per user, shared across projects through links.`,
    "",
    "Usage: snpm <command> [args] [--json]",
    "",
    "Dependency commands (not implemented yet):",
  ];
  for (const [names, description] of NATIVE_COMMANDS) {
    lines.push(`  ${names.padEnd(24, " ")}${description}`);
  }
  lines.push("", "Registry publishing and account commands (via your npm):");
  lines.push(...delegatedHelpLines());
  lines.push(
    "",
    "snpm never installs packages globally and never runs npm to do it.",
    "Need a global package? Run npm directly: npm install --global <package-spec>",
  );
  return `${lines.join("\n")}\n`;
}

export type CliOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function ok(stdout: string, parsed: ParsedArgs): CliOutput {
  if (!parsed.json) return { exitCode: 0, stdout, stderr: "" };
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, status: "ok" })}\n`,
    stderr: "",
  };
}

function fail(
  error: SnpmError,
  parsed: ParsedArgs,
  stdoutHint = "",
): CliOutput {
  const human =
    `snpm: error ${error.code}: ${error.message}` +
    (error.remedy === undefined ? "" : `\n${error.remedy}`);
  if (!parsed.json) {
    return {
      exitCode: exitCodeFor(error),
      stdout: stdoutHint,
      stderr: `${human}\n`,
    };
  }
  const body: Record<string, unknown> = {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    status: "error",
    code: error.code,
    message: error.message,
  };
  if (error.remedy !== undefined) body.remedy = error.remedy;
  return {
    exitCode: exitCodeFor(error),
    stdout: `${JSON.stringify(body)}\n`,
    stderr: "",
  };
}

function globalInstallError(command: string): SnpmError {
  return new SnpmError(
    "SNPM_GLOBAL_INSTALL_UNSUPPORTED",
    `snpm does not install packages globally (requested: snpm ${command} with global-install mode).`,
    {
      detail: { command },
      remedy:
        "Shared storage is not global installation. Run npm directly, for example: " +
        "npm install --global <package-spec>. snpm will not run npm for you.",
    },
  );
}

/**
 * Pure dispatch: no filesystem, network, or subprocess effects. Returns the
 * exact bytes for stdout/stderr and the process exit code.
 */
export function dispatch(
  parsed: ParsedArgs,
  context: { version: string; env: NodeJS.ProcessEnv },
): CliOutput {
  if (parsed.version) {
    return ok(`${context.version}\n`, parsed);
  }
  if (parsed.help || parsed.command === undefined) {
    return ok(helpText(context.version), parsed);
  }
  const command = parsed.command;
  if (isGlobalInstallRequest(command, parsed.commandArgs, context.env)) {
    return fail(globalInstallError(command), parsed);
  }
  if (!KNOWN_COMMANDS.has(command)) {
    return fail(
      new SnpmError("SNPM_USAGE", `unknown command: ${command}.`, {
        detail: { command },
        remedy: "Run `snpm --help` for the documented command list.",
      }),
      parsed,
      helpText(context.version),
    );
  }
  return fail(
    new SnpmError(
      "SNPM_NOT_IMPLEMENTED",
      `snpm ${command} is not implemented yet.`,
      {
        detail: { command },
        remedy:
          "Only documented, implemented commands are advertised; this one is on the roadmap.",
      },
    ),
    parsed,
  );
}

function readCliVersion(): string {
  try {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export type RunCliOptions = {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  readVersion?: () => string;
};

/** Parse, dispatch or delegate, and emit. The only impure seam. */
export async function runCli(options: RunCliOptions): Promise<number> {
  const parsed = parseArgs(options.argv);
  const emit = (result: CliOutput): number => {
    if (result.stdout !== "") options.stdout.write(result.stdout);
    if (result.stderr !== "") options.stderr.write(result.stderr);
    return result.exitCode;
  };
  // Delegation bypasses dispatch: snpm interprets nothing after the command
  // token, adds no JSON envelope, and forwards the raw tail verbatim.
  if (
    !parsed.help &&
    !parsed.version &&
    parsed.command !== undefined &&
    isDelegatedCommand(parsed.command)
  ) {
    try {
      return await delegateToNpm({
        command: parsed.command,
        args: parsed.argsAfterCommand,
        env: options.env,
        stderr: options.stderr,
      });
    } catch (error) {
      return emit(
        fail(
          toSnpmError(error, "snpm failed while delegating to npm."),
          parsed,
        ),
      );
    }
  }
  const version = (options.readVersion ?? readCliVersion)();
  return emit(dispatch(parsed, { version, env: options.env }));
}
