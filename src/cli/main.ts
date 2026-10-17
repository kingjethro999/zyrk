/**
 * zyrk command dispatch (SPEC 15).
 *
 * This is the roadmap skeleton, not the whole implementation: `dlx` and
 * `create` run temporary tool environments; `--help`, `--version`, the
 * global-install rejection, and explicit npm delegation do their jobs.
 * `install` publishes a verified shared project graph. Other dependency
 * commands fail with ZYRK_NOT_IMPLEMENTED rather than pretending to work;
 * unknown commands fail with ZYRK_USAGE
 * and the help text.
 * Nothing here launches a subprocess: rejection happens before resolution,
 * downloads, lifecycle execution, project/store mutation, or any child
 * process (SPEC 15.3.1).
 */

import { installProject, type InstallOptions } from "../install/run.ts";
import { installRegistry } from "../install/registry.ts";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runCreate } from "../dlx/create.ts";
import { runDlx } from "../dlx/run.ts";
import {
  runDependencyCommand,
  type DependencyCommand,
} from "../commands/dependencies.ts";
import {
  runProjectCommand,
  type ProjectCommandOptions,
} from "../commands/project.ts";
import { runStoreCommand } from "../commands/store.ts";
import { exitCodeFor, ZyrkError, toZyrkError } from "../errors.ts";
export { ZyrkError };
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
const IMPLEMENTED_COMMANDS = new Set([
  "dlx",
  "create",
  "install",
  "i",
  "add",
  "remove",
  "update",
  "import",
  "run",
  "exec",
  "list",
  "why",
  "doctor",
  "repair",
  "store",
  "projects",
]);

export function helpText(version: string): string {
  const lines = [
    `zyrk v${version} — one verified store per user, shared across projects through links.`,
    "",
    "Usage: zyrk <command> [args] [--json]",
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
    "zyrk never installs packages globally and never runs npm to do it.",
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
  error: ZyrkError,
  parsed: ParsedArgs,
  stdoutHint = "",
): CliOutput {
  const human =
    `zyrk: error ${error.code}: ${error.message}` +
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

function globalInstallError(command: string): ZyrkError {
  return new ZyrkError(
    "ZYRK_GLOBAL_INSTALL_UNSUPPORTED",
    `zyrk does not install packages globally (requested: zyrk ${command} with global-install mode).`,
    {
      detail: { command },
      remedy:
        "Shared storage is not global installation. Run npm directly, for example: " +
        "npm install --global <package-spec>. zyrk will not run npm for you.",
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
      new ZyrkError("ZYRK_USAGE", `unknown command: ${shown}.`, {
        detail: { command: shown },
        remedy: `Run \`zyrk --help\` for the documented command list.${placementHint}`,
      }),
      parsed,
      helpText(context.version),
    );
  }
  if (!IMPLEMENTED_COMMANDS.has(command)) {
    return fail(
      new ZyrkError(
        "ZYRK_NOT_IMPLEMENTED",
        `zyrk ${command} is not implemented yet.`,
        {
          detail: { command },
          remedy:
            "Only documented, implemented commands are advertised; this one is on the roadmap.",
        },
      ),
      parsed,
    );
  }
  throw new ZyrkError(
    "ZYRK_INTERNAL",
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
  // Delegation bypasses dispatch: zyrk interprets no command arguments
  // itself, adds no JSON envelope, and forwards every non-zyrk token
  // verbatim — before the command as well as after it. A leading
  // protective flag such as `--dry-run` belongs to npm; dropping it would
  // silently change what runs (S05). The only tokens zyrk consumes are its
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
          toZyrkError(error, "zyrk failed while delegating to npm."),
          parsed,
        ),
      );
    }
  }
  if (
    !parsed.help &&
    !parsed.version &&
    (parsed.command === "install" || parsed.command === "i")
  ) {
    if (isGlobalInstallRequest(parsed.command, parsed.commandArgs, options.env))
      return emit(fail(globalInstallError(parsed.command), parsed));
    try {
      if (
        parsed.commandArgs.includes("--help") ||
        parsed.commandArgs.includes("-h")
      ) {
        return emit(
          ok(
            "Usage: zyrk install [package[@version] ...] [-D] [--save-exact] [--frozen-lockfile] [--offline] [--ignore-scripts] [--lockfile-only] [--omit=dev] [--registry=https://registry.npmjs.org/] [--json]\n",
            parsed,
          ),
        );
      }
      const specs: string[] = [];
      const flags: Partial<InstallOptions> = {};
      let registryUrl: string | undefined;
      for (const token of parsed.commandArgs) {
        if (token === "--frozen-lockfile") flags.frozen = true;
        else if (token === "--offline") flags.offline = true;
        else if (token === "--ignore-scripts") flags.ignoreScripts = true;
        else if (token === "--lockfile-only") flags.lockfileOnly = true;
        else if (token === "--omit=dev" || token === "--production")
          flags.omitDev = true;
        else if (token === "-D" || token === "--save-dev") flags.saveDev = true;
        else if (token === "-E" || token === "--save-exact")
          flags.saveExact = true;
        else if (token === "--no-global" || token === "--global=false")
          continue;
        else if (token.startsWith("--registry="))
          registryUrl = token.slice("--registry=".length);
        else if (token.startsWith("-"))
          throw new ZyrkError("ZYRK_USAGE", "Unsupported install option.", {
            remedy:
              "Run zyrk install --help for supported options; use --registry=URL for a custom registry.",
          });
        else specs.push(token);
      }
      const cwd = options.cwd ?? process.cwd();
      const tools = options.tools
        ? await options.tools()
        : {
            registry: await installRegistry({
              cwd,
              env: options.env,
              version,
              ...(registryUrl === undefined ? {} : { registry: registryUrl }),
            }),
            store: await Store.open({
              root: resolveStoreRoot({ env: options.env }).root,
              create: true,
            }),
          };
      const result = await installProject({
        ...flags,
        specs,
        projectDir: cwd,
        ...tools,
      });
      if (parsed.json)
        return emit({
          exitCode: 0,
          stdout: `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, status: "ok", ...result })}\n`,
          stderr: "",
        });
      const summary =
        result.readiness === "lockfile-only"
          ? "Lockfile written; dependencies were not installed."
          : `Installed ${result.packages} packages using shared storage (${result.reused} realizations reused); ${result.readiness}.`;
      return emit({
        exitCode: 0,
        stdout: `${summary}\n`,
        stderr: result.warnings.map((w) => `zyrk: ${w}\n`).join(""),
      });
    } catch (error) {
      return emit(fail(toZyrkError(error, "zyrk install failed."), parsed));
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
        fail(toZyrkError(error, `zyrk ${parsed.command} failed.`), parsed),
      );
    }
  }

  // Dependency commands: add, remove, update, import
  if (
    !parsed.help &&
    !parsed.version &&
    (parsed.command === "add" ||
      parsed.command === "remove" ||
      parsed.command === "update" ||
      parsed.command === "import")
  ) {
    try {
      const tools =
        options.tools === undefined
          ? await defaultTools(options.env, version)
          : await options.tools();
      const result = await runDependencyCommand({
        command: parsed.command as DependencyCommand,
        args: parsed.commandArgs,
        projectDir: options.cwd ?? process.cwd(),
        store: tools.store,
        registry: tools.registry,
      });
      if (parsed.json) {
        return emit({
          exitCode: 0,
          stdout: `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, status: "ok", ...result })}\n`,
          stderr: "",
        });
      }
      return emit({
        exitCode: 0,
        stdout: `Dependency command ${parsed.command} completed.\n`,
        stderr: "",
      });
    } catch (error) {
      return emit(
        fail(toZyrkError(error, `zyrk ${parsed.command} failed.`), parsed),
      );
    }
  }

  // Project commands: run, exec, list, why, doctor, repair
  if (
    !parsed.help &&
    !parsed.version &&
    (parsed.command === "run" ||
      parsed.command === "exec" ||
      parsed.command === "list" ||
      parsed.command === "why" ||
      parsed.command === "doctor" ||
      parsed.command === "repair")
  ) {
    try {
      return await runProjectCommand({
        command: parsed.command,
        args: parsed.commandArgs,
        cwd: options.cwd ?? process.cwd(),
        env: options.env,
        stdout: options.stdout,
        stderr: options.stderr,
        json: parsed.json,
      });
    } catch (error) {
      return emit(
        fail(toZyrkError(error, `zyrk ${parsed.command} failed.`), parsed),
      );
    }
  }

  // Store and projects commands: store path/status/verify/gc/pin/unpin, projects list/forget
  if (
    !parsed.help &&
    !parsed.version &&
    (parsed.command === "store" || parsed.command === "projects")
  ) {
    try {
      const tools =
        options.tools === undefined
          ? await defaultTools(options.env, version)
          : await options.tools();
      const result = await runStoreCommand({
        command: parsed.command as "store" | "projects",
        args: parsed.commandArgs,
        store: tools.store,
        cwd: options.cwd ?? process.cwd(),
        json: parsed.json,
      });
      if (parsed.json) {
        return emit({
          exitCode: 0,
          stdout: `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, status: "ok", ...(result as Record<string, unknown>) })}\n`,
          stderr: "",
        });
      }
      return emit({
        exitCode: 0,
        stdout: `${JSON.stringify(result)}\n`,
        stderr: "",
      });
    } catch (error) {
      return emit(
        fail(toZyrkError(error, `zyrk ${parsed.command} failed.`), parsed),
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
    userAgent: `zyrk/${version}`,
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
    throw new ZyrkError(
      "ZYRK_USAGE",
      `zyrk ${command} does not support --json; the tool owns stdout.`,
      {
        detail: { command },
        remedy: `run zyrk ${command} without --json.`,
      },
    );
  }
  const tail = parsed.commandArgs;
  const first = tail[0];
  if (first === undefined) {
    throw new ZyrkError(
      "ZYRK_USAGE",
      command === "dlx"
        ? "zyrk dlx needs a tool specifier."
        : "zyrk create needs an initializer name.",
      {
        detail: { command },
        remedy:
          command === "dlx"
            ? "use zyrk dlx <package>[@version] [args...]."
            : "use zyrk create <name>[@version] [args...].",
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
