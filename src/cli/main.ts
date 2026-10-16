/**
 * nexu command dispatch (SPEC 15).
 *
 * This is the roadmap skeleton, not the whole implementation: `dlx` and
 * `create` run temporary tool environments; `--help`, `--version`, the
 * global-install rejection, and explicit npm delegation do their jobs.
 * Every other native dependency command fails with NEXU_NOT_IMPLEMENTED
 * rather than pretending to work; unknown commands fail with NEXU_USAGE
 * and the help text.
 * Nothing here launches a subprocess: rejection happens before resolution,
 * downloads, lifecycle execution, project/store mutation, or any child
 * process (SPEC 15.3.1).
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runCreate } from "../dlx/create.ts";
import { runDlx } from "../dlx/run.ts";
import { exitCodeFor, NexuError, toNexuError } from "../errors.ts";
import { DEFAULT_REGISTRY, RegistryClient } from "../fetch/registry.ts";
import { resolveStoreRoot } from "../config/paths.ts";
import { Store } from "../store/layout.ts";
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
  ["create", "Scaffold from a create-* starter package."],
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

/** Commands with a real implementation behind runCli. */
const IMPLEMENTED_COMMANDS = new Set(["dlx", "create"]);

export function helpText(version: string): string {
  const lines = [
    `nexu v${version} — one verified store per user, shared across projects through links.`,
    "",
    "Usage: nexu <command> [args] [--json]",
    "",
    "Dependency commands:",
  ];
  for (const [names, description] of NATIVE_COMMANDS) {
    const done = names
      .split(", ")
      .some((name) => IMPLEMENTED_COMMANDS.has(name));
    lines.push(
      `  ${names.padEnd(24, " ")}${description}${done ? "" : " (not implemented yet)"}`,
    );
  }
  lines.push("", "Registry publishing and account commands (via your npm):");
  lines.push(...delegatedHelpLines());
  lines.push(
    "",
    "nexu never installs packages globally and never runs npm to do it.",
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
  error: NexuError,
  parsed: ParsedArgs,
  stdoutHint = "",
): CliOutput {
  const human =
    `nexu: error ${error.code}: ${error.message}` +
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

/**
 * Echo a command token back safely: drop control characters, cap length,
 * and strip URL userinfo so error output cannot leak credentials or forge
 * terminal sequences. Full structured output redaction is S03; this covers
 * the one place CLI dispatch interpolates an arbitrary token today.
 */
/**
 * Drop C0 control characters and DEL without regex escapes.
 */
function stripControlChars(token: string): string {
  let out = "";
  for (const ch of token) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code >= 32 && code !== 127) out += ch;
  }
  return out;
}

function sanitizeCommandToken(token: string): string {
  const oneLine = stripControlChars(token);
  const capped = oneLine.length > 64 ? `${oneLine.slice(0, 64)}…` : oneLine;
  return capped.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^@/]*@)?/, "$1");
}

function globalInstallError(command: string): NexuError {
  return new NexuError(
    "NEXU_GLOBAL_INSTALL_UNSUPPORTED",
    `nexu does not install packages globally (requested: nexu ${command} with global-install mode).`,
    {
      detail: { command },
      remedy:
        "Shared storage is not global installation. Run npm directly, for example: " +
        "npm install --global <package-spec>. nexu will not run npm for you.",
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
    const shown = sanitizeCommandToken(command);
    const placementHint =
      command.includes("://") || parsed.argsBeforeCommand.length > 0
        ? " If this was an option value, use the --flag=value form or place the command first."
        : "";
    return fail(
      new NexuError("NEXU_USAGE", `unknown command: ${shown}.`, {
        detail: { command: shown },
        remedy: `Run \`nexu --help\` for the documented command list.${placementHint}`,
      }),
      parsed,
      helpText(context.version),
    );
  }
  if (!IMPLEMENTED_COMMANDS.has(command)) {
    return fail(
      new NexuError(
        "NEXU_NOT_IMPLEMENTED",
        `nexu ${command} is not implemented yet.`,
        {
          detail: { command },
          remedy:
            "Only documented, implemented commands are advertised; this one is on the roadmap.",
        },
      ),
      parsed,
    );
  }
  throw new NexuError(
    "NEXU_INTERNAL",
    `implemented command ${command} bypassed runCli.`,
    {
      detail: { command },
      remedy: "report this unreachable dispatch failure",
    },
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

export type ToolEnvironment = {
  store: Store;
  registry: RegistryClient;
};

export type RunCliOptions = {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  readVersion?: () => string;
  cwd?: string;
  tools?: () => Promise<ToolEnvironment>;
};

/** Parse, dispatch, delegate, or run a tool, and emit. The only impure seam. */
export async function runCli(options: RunCliOptions): Promise<number> {
  const parsed = parseArgs(options.argv);
  const version = (options.readVersion ?? readCliVersion)();
  const emit = (result: CliOutput): number => {
    if (result.stdout !== "") options.stdout.write(result.stdout);
    if (result.stderr !== "") options.stderr.write(result.stderr);
    return result.exitCode;
  };
  // Delegation bypasses dispatch: nexu interprets no command arguments
  // itself, adds no JSON envelope, and forwards every non-nexu token
  // verbatim — before the command as well as after it. A leading
  // protective flag such as `--dry-run` belongs to npm; dropping it would
  // silently change what runs (S05). The only tokens nexu consumes are its
  // own `--json`/`--help`/`--version`, and `--json` is passed on so npm
  // still sees exactly what it was given.
  if (
    !parsed.help &&
    !parsed.version &&
    parsed.command !== undefined &&
    isDelegatedCommand(parsed.command)
  ) {
    try {
      const forwarded = [...parsed.argsBeforeCommand];
      if (parsed.json && !parsed.argsAfterCommand.includes("--json")) {
        forwarded.push("--json");
      }
      forwarded.push(...parsed.argsAfterCommand);
      return await delegateToNpm({
        command: parsed.command,
        args: forwarded,
        env: options.env,
        stderr: options.stderr,
      });
    } catch (error) {
      return emit(
        fail(
          toNexuError(error, "nexu failed while delegating to npm."),
          parsed,
        ),
      );
    }
  }
  if (
    !parsed.help &&
    !parsed.version &&
    (parsed.command === "dlx" || parsed.command === "create")
  ) {
    try {
      return await runToolCommand(parsed.command, parsed, options, version);
    } catch (error) {
      return emit(
        fail(toNexuError(error, `nexu ${parsed.command} failed.`), parsed),
      );
    }
  }
  return emit(dispatch(parsed, { version, env: options.env }));
}

async function defaultTools(
  env: NodeJS.ProcessEnv,
  version: string,
): Promise<ToolEnvironment> {
  const store = await Store.open({
    root: resolveStoreRoot({ env }).root,
    create: true,
  });
  const registry = new RegistryClient({
    registry: DEFAULT_REGISTRY,
    userAgent: `nexu/${version}`,
  });
  return { store, registry };
}

async function runToolCommand(
  command: "dlx" | "create",
  parsed: ParsedArgs,
  options: RunCliOptions,
  version: string,
): Promise<number> {
  if (parsed.json) {
    throw new NexuError(
      "NEXU_USAGE",
      `nexu ${command} does not support --json; the tool owns stdout.`,
      {
        detail: { command },
        remedy: `run nexu ${command} without --json.`,
      },
    );
  }
  const tail = parsed.commandArgs;
  const first = tail[0];
  if (first === undefined) {
    throw new NexuError(
      "NEXU_USAGE",
      command === "dlx"
        ? "nexu dlx needs a tool specifier."
        : "nexu create needs an initializer name.",
      {
        detail: { command },
        remedy:
          command === "dlx"
            ? "use nexu dlx <package>[@version] [args...]."
            : "use nexu create <name>[@version] [args...].",
      },
    );
  }
  const tools =
    options.tools === undefined
      ? await defaultTools(options.env, version)
      : await options.tools();
  const base = {
    store: tools.store,
    registry: tools.registry,
    args: tail.slice(1),
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
  };
  if (command === "dlx") {
    return (await runDlx({ ...base, spec: first })).exitCode;
  }
  return (await runCreate({ ...base, input: first })).exitCode;
}
