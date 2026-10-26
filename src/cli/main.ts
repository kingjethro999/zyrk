import { runNextCommand } from "../commands/next.ts";
import { createInstallProgress, type InstallCompletion } from "./progress.ts";
import { renderBuildReviews } from "./build-approval.ts";
import { completionScript, suggestCommand } from "./completion.ts";
import { renderCommandError, renderCommandOutput } from "./terminal.ts";
import { runMaintenanceCommand } from "../commands/maintenance.ts";
import { runDeployCommand } from "../commands/deploy.ts";
import { runPatchCommand } from "../commands/patch.ts";
import { sanitizeDiagnostic, redactSecrets } from "../log.ts";
/** zyrk command dispatch (SPEC 15).
 * Native handlers share validated graph and registry adapters; delegated registry
 * operations preserve npm arguments. Global install rejection precedes effects.
 * Unsupported command modes fail explicitly in their handler.
 */

import {
  installProject,
  type InstallOptions,
  type InstallResult,
} from "../install/run.ts";
import type { BuildCandidate, BuildReview } from "../install/private.ts";
import { installRegistry } from "../install/registry.ts";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runCreate, starterSpecFor } from "../dlx/create.ts";
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
import { findProjectBoundary, resolveStoreRoot } from "../config/paths.ts";
import { Store } from "../store/layout.ts";
import {
  delegateToNpm,
  delegatedHelpLines,
  DELEGATED_COMMAND_NAMES,
  isDelegatedCommand,
} from "./npm-delegate.ts";
import { isGlobalInstallRequest, parseArgs, type ParsedArgs } from "./parse.ts";

export const CLI_JSON_SCHEMA_VERSION = 1;

function installCompletion(
  readiness: InstallResult["readiness"],
): InstallCompletion {
  switch (readiness) {
    case "ready":
      return {
        title: "Installed from the verified shared store.",
        detail: "Your project still uses node_modules and normal imports.",
      };
    case "intentionally-unbuilt":
      return {
        tone: "attention",
        title: "Installed; some dependency builds were intentionally skipped.",
        detail:
          "Review build policy before running packages that need those builds.",
      };
    case "fetched":
      return { title: "Verified package sources in the shared store." };
    case "lockfile-only":
      return { title: "Lockfile updated; dependencies were not installed." };
    case "build-review":
      return { title: "Build review saved; dependency scripts were not run." };
  }
}

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
  ["next", "Explicitly configure Next Turbopack: next --turbopack."],
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
  ["completion", "Generate static Bash, Zsh, or Fish completions."],
];

const KNOWN_COMMANDS = new Set<string>();
for (const [names] of NATIVE_COMMANDS) {
  for (const name of names.split(", ")) KNOWN_COMMANDS.add(name);
}

/** Commands with a real implementation behind runCli. */
const IMPLEMENTED_COMMANDS = new Set([
  "dlx",
  "create",
  "next",
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
  "fetch",
  "audit",
  "approve-builds",
  "rebuild",
  "patch",
  "patch-commit",
  "deploy",
  "docker",
  "completion",
]);

export function helpText(version: string): string {
  const lines = [
    `zyrk v${version} — one verified store per user, shared across projects through links.`,
    "",
    "Usage: zyrk <command> [args] [--json]",
    "       zyrk <script> [args]  (shortcut for zyrk run <script> [args])",
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
    "Install timeouts: ZYRK_RESOLVE_TIMEOUT_MS and ZYRK_EXTRACT_TIMEOUT_MS (1..900000 ms); ZYRK_REQUEST_TIMEOUT_MS (1..3600000 ms); ZYRK_FETCH_TIMEOUT_MS (1..3600000 ms).",
    "zyrk never installs packages globally and never runs npm to do it.",
    "Need a global package? Run npm directly: npm install --global <package-spec>",
  );
  return `${lines.join("\n")}\n`;
}

const COMMAND_HELP: Readonly<Record<string, string>> = {
  completion: `Usage: zyrk completion <bash|zsh|fish>

Print a static completion script. No network, package code, or project discovery runs.
Load the output using your shell's completion setup. JSON mode returns the script as data.

Example: zyrk completion bash > zyrk-completion.bash`,
  install: `Usage: zyrk install [package[@version] ...] [options]

Install the project graph, or add the supplied packages. A portable package-lock.json records selections; the user store path stays machine-local.

Options:
  --frozen-lockfile  Fail if the lock does not match the project
  --offline          Use verified local sources only
  --ignore-scripts   Skip dependency lifecycle scripts
  --lockfile-only    Write selections without linking dependencies
  --omit=dev         Omit development dependencies
  -D, --save-dev     Save added packages as development dependencies
  -E, --save-exact   Save exact versions when adding packages
  --registry=URL     Use the selected registry for this operation

Examples:
  zyrk install
  zyrk install --frozen-lockfile
  zyrk install prettier -D`,
  i: `Usage: zyrk i [package[@version] ...] [options]

Alias for zyrk install. See zyrk install --help for supported options and examples.`,
  add: `Usage: zyrk add <package[@version] ...> [options]

Add packages and install the updated project graph.

Options:
  -D, --save-dev       Save as development dependencies
  -O, --save-optional  Save as optional dependencies
  -E, --save-exact     Save exact versions
  --ignore-scripts     Skip dependency lifecycle scripts
  --lockfile-only      Update the lock without linking dependencies

Example: zyrk add prettier -D`,
  remove: `Usage: zyrk remove <package ...> [--ignore-scripts] [--lockfile-only]

Remove direct dependencies and install the resulting graph.

Example: zyrk remove prettier`,
  update: `Usage: zyrk update [package ...] [options]

Update selected packages, or all direct dependencies when no package is named.

Options:
  --latest           Select the latest versions, ignoring declared ranges
  -E, --save-exact   Save exact versions
  --ignore-scripts   Skip dependency lifecycle scripts
  --lockfile-only    Update the lock without linking dependencies

Example: zyrk update typescript`,
  import: `Usage: zyrk import --from npm [--ignore-scripts] [--lockfile-only]

Import supported selections from package-lock.json and install the graph.

Example: zyrk import --from npm`,
  run: `Usage: zyrk run [--workspace <name-or-path>] <script> [-- <args...>]
       zyrk <script> [args...]

Run a declared package script with local executable paths. The script runs in its package directory.

Examples:
  zyrk run build
  zyrk dev
  zyrk run --workspace web dev`,
  exec: `Usage: zyrk exec [--workspace <name-or-path>] <executable> [args...]

Run an executable already installed in the project. This command never fetches packages.

Example: zyrk exec tsc --noEmit`,
  list: `Usage: zyrk list [--workspace <name-or-path>] [--json]

Show the installed project dependency graph. Use --json for machine-readable output.`,
  why: `Usage: zyrk why [--workspace <name-or-path>] <package> [--json]

Show the selected installed instances for a package. Use --json for machine-readable output.`,
  doctor: `Usage: zyrk doctor [--workspace <name-or-path>] [--json]

Read-only diagnostics for project files, installed links, policy, and installation state.`,
  fetch: `Usage: zyrk fetch --frozen-lockfile [--offline]

Fetch and verify the locked source closure without linking project dependencies.

Example: zyrk fetch --frozen-lockfile --offline`,
  audit: `Usage: zyrk audit [--audit-level <severity>] [--offline]

Report advisories using the configured privacy policy. Severity is info, low, moderate, high, or critical.

Example: zyrk audit --audit-level high`,
  repair: `Usage: zyrk repair [--offline]

Reconstruct project links from verified sources selected by the existing lockfile.`,
  "approve-builds": `Usage: zyrk approve-builds [package ... | --all]

Review exact source identities, lifecycle commands, and current policy decisions without running package code. Selected approvals persist to zyrk-workspace.json; user and project denies take precedence. Approved scripts are not sandboxed.

Example: zyrk approve-builds`,
  rebuild: `Usage: zyrk rebuild [--offline]

Run previously approved dependency builds for the complete locked project graph.`,
  next: `Usage: zyrk next --turbopack

Explicitly configure the supported Next.js Turbopack adapter. The command preserves the existing configuration and writes a backup.

Example: zyrk next --turbopack`,
  dlx: `Usage: zyrk dlx <package[@version]> [args...]

Fetch a temporary tool environment and run its executable. Tool arguments after the package are passed to that executable.

Example: zyrk dlx vite --help`,
  create: `Usage: zyrk create <initializer[@version]> [args...]

Run a supported project initializer. Next.js scaffolds install dependencies with Zyrk; initializer arguments are passed through.

Example: zyrk create next-app web`,
  patch: `Usage: zyrk patch <package>

Create a private editing area for a selected installed package source.

Example: zyrk patch left-pad`,
  "patch-commit": `Usage: zyrk patch-commit <package>

Validate edits in a private package editing area and record the project patch.

Example: zyrk patch-commit left-pad`,
  store: `Usage: zyrk store <action>

Actions:
  path                 Print the configured store path
  status               Show store initialization and counts
  verify --full        Verify stored objects and realizations
  gc [--dry-run]       Collect eligible unreferenced data
  pin <project>        Retain a project closure
  unpin <pin-id>       Remove a retention pin

Use zyrk store gc --dry-run to preview collection.`,
  projects: `Usage: zyrk projects <list | forget> [project-id]

List registered projects or explicitly drop a retention root.

Examples:
  zyrk projects list
  zyrk projects forget <project-id>`,
  deploy: `Usage: zyrk deploy --out <new-directory> [options]

Create a self-contained production output from an installed, verified project. The output directory's parent must already exist and the output directory must be new.

Options:
  --omit=dev         Omit development dependencies
  --files <path>     Include a runtime file (repeatable), or declare package.json files
  --entry <path>     Select the direct Node entry point

Example: zyrk deploy --out release --files dist --entry dist/server.js`,
  docker: `Usage: zyrk docker <init | build | run> [options]

Generate a pinned Docker setup, build its image, or run it locally.

Examples:
  zyrk docker init --help
  zyrk docker build --tag app:local
  zyrk docker run --tag app:local`,
};

function commandHelpText(command: string): string | undefined {
  const help = COMMAND_HELP[command];
  return help === undefined ? undefined : `${help}\n`;
}

function requestedCommandHelp(
  command: string,
  args: readonly string[],
): string | undefined {
  if (
    command === "docker" &&
    args[1] !== undefined &&
    ["-h", "--help"].includes(args[1])
  ) {
    const action = args[0];
    if (action === "init")
      return `Usage: zyrk docker init --node-image <image@sha256:digest> --cli-artifact <path> --cli-sha512 <digest> [options]\n\nGenerate reviewable Docker setup files. The pinned Node image and Zyrk CLI artifact are required.\n\nOptions: --build-script <script> --entry <file> --files <file>... --port <1..65535>\n`;
    if (action === "build")
      return `Usage: zyrk docker build --tag <local-image>\n\nBuild the generated Dockerfile with the explicit local image tag.\n`;
    if (action === "run")
      return `Usage: zyrk docker run --tag <local-image> [--port <host-port>]\n\nRun the generated application container and publish its configured port.\n`;
  }
  if (
    command === "store" &&
    args[1] !== undefined &&
    ["-h", "--help"].includes(args[1])
  )
    return commandHelpText("store");
  if (
    command === "projects" &&
    args[1] !== undefined &&
    ["-h", "--help"].includes(args[1])
  )
    return commandHelpText("projects");
  if (args[0] !== "--help" && args[0] !== "-h") return undefined;
  return commandHelpText(command);
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
    stdout: `${JSON.stringify(sanitizeDiagnostic(body))}\n`,
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
    const suggestion = suggestCommand(command, [
      ...KNOWN_COMMANDS,
      ...DELEGATED_COMMAND_NAMES,
    ]);
    const placementHint =
      command.includes("://") || parsed.argsBeforeCommand.length > 0
        ? " If this was an option value, use the --flag=value form or place the command first."
        : "";
    return fail(
      new ZyrkError("ZYRK_USAGE", `unknown command: ${shown}.`, {
        detail: { command: shown },
        remedy: `${suggestion ? `Did you mean zyrk ${suggestion}? ` : ""}Run \`zyrk --help\` for the documented command list.${placementHint}`,
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
  stdin?: NodeJS.ReadStream;
  stdout: { write(chunk: string): unknown; isTTY?: boolean };
  stderr: { write(chunk: string): unknown; isTTY?: boolean };
  readVersion?: () => string;
  cwd?: string;
  tools?: () => Promise<ToolEnvironment>;
};

async function promptForBuildApproval(
  builds: readonly BuildCandidate[],
  input: NodeJS.ReadStream,
  output: { write(chunk: string): unknown },
): Promise<string[]> {
  output.write(
    "\nDependency build approval\nScripts run with your OS account permissions; approval is not a sandbox.\nSelected exact-source approvals are saved to zyrk-workspace.json for collaborators.\n\n",
  );
  builds.forEach((build, index) => {
    const stages = build.stages
      .map(
        (stage) =>
          `${stage.name}: ${redactSecrets(stage.command)
            .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
            .slice(0, 180)}`,
      )
      .join("; ");
    output.write(
      `  ${index + 1}. [ ] ${build.name}@${build.version}\n     source: ${build.sourceId}\n     lifecycle: ${stages}\n`,
    );
  });
  output.write(
    "Enter numbers separated by commas to approve selected sources, `all` to approve all listed sources, or press Enter to skip pending scripts and continue intentionally unbuilt.\n",
  );
  const prompt = createInterface({
    input,
    output: output as NodeJS.WritableStream,
    terminal: true,
  });
  try {
    const answer = (await prompt.question("Approve builds> ")).trim();
    if (!answer) return [];
    if (answer.toLowerCase() === "all") return ["*"];
    const numbers = answer.split(/[ ,]+/).map((value) => Number(value));
    if (
      numbers.some(
        (number) =>
          !Number.isInteger(number) || number < 1 || number > builds.length,
      )
    )
      throw new ZyrkError(
        "ZYRK_USAGE",
        "Build selection contains an invalid candidate number.",
        {
          remedy: `Select numbers from 1 to ${builds.length}, enter all, or press Enter to skip scripts.`,
        },
      );
    return [...new Set(numbers)].map((number) => builds[number - 1]!.sourceId);
  } finally {
    prompt.close();
  }
}

/** Parse, dispatch, delegate, or run a tool, and emit. The only impure seam. */
export async function runCli(options: RunCliOptions): Promise<number> {
  const parsed = parseArgs(options.argv);
  const version = (options.readVersion ?? readCliVersion)();
  const emit = (result: CliOutput): number => {
    const interactive =
      !parsed.json &&
      !parsed.help &&
      !parsed.version &&
      options.stdout.isTTY === true &&
      parsed.command !== undefined &&
      !isDelegatedCommand(parsed.command);
    const style = {
      isTTY: interactive,
      color:
        interactive &&
        options.env.NO_COLOR === undefined &&
        options.env.TERM !== "dumb",
    };
    if (result.stdout !== "")
      options.stdout.write(
        interactive
          ? renderCommandOutput(
              parsed.command ?? "command",
              result.stdout,
              style,
            )
          : result.stdout,
      );
    if (result.stderr !== "")
      options.stderr.write(
        result.exitCode !== 0
          ? renderCommandError(result.stderr, {
              ...style,
              isTTY: options.stderr.isTTY === true && !parsed.json,
            })
          : result.stderr,
      );
    return result.exitCode;
  };
  if (
    !parsed.help &&
    !parsed.version &&
    parsed.command &&
    isGlobalInstallRequest(parsed.command, parsed.commandArgs, options.env)
  )
    return emit(fail(globalInstallError(parsed.command), parsed));
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
  if (!parsed.help && !parsed.version && parsed.command !== undefined) {
    const help = requestedCommandHelp(parsed.command, parsed.commandArgs);
    if (help !== undefined) return emit(ok(help, parsed));
  }
  if (!parsed.help && !parsed.version && parsed.command === "completion") {
    try {
      if (parsed.commandArgs.length !== 1)
        throw new ZyrkError(
          "ZYRK_USAGE",
          "Select exactly one completion shell.",
          { remedy: "Use zyrk completion bash, zsh, or fish." },
        );
      const shell = parsed.commandArgs[0]!;
      const script = completionScript(shell, [
        ...KNOWN_COMMANDS,
        ...DELEGATED_COMMAND_NAMES,
      ]);
      // Generated shell code must never receive TTY decoration.
      options.stdout.write(
        parsed.json
          ? `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, status: "ok", shell, script })}\n`
          : script,
      );
      return 0;
    } catch (error) {
      return emit(
        fail(toZyrkError(error, "Cannot generate shell completion."), parsed),
      );
    }
  }
  if (
    !parsed.help &&
    !parsed.version &&
    parsed.command &&
    [
      "fetch",
      "audit",
      "approve-builds",
      "rebuild",
      "repair",
      "patch",
      "patch-commit",
      "deploy",
      "docker",
    ].includes(parsed.command)
  ) {
    try {
      const command = parsed.command,
        cwd = options.cwd ?? process.cwd();
      if (command === "deploy" || command === "docker")
        return await runDeployCommand({
          command,
          args: parsed.commandArgs,
          cwd,
          env: options.env,
          stdout: options.stdout,
          stderr: options.stderr,
          json: parsed.json,
        });
      const tools = options.tools
        ? await options.tools()
        : await defaultTools(options.env, version, cwd);
      let result: unknown;
      if (command === "patch" || command === "patch-commit")
        result = await runPatchCommand({
          command,
          args: parsed.commandArgs,
          cwd,
          store: tools.store,
        });
      else if (command === "approve-builds") {
        if (parsed.commandArgs.some((v) => v.startsWith("-") && v !== "--all"))
          throw new ZyrkError(
            "ZYRK_USAGE",
            "Unsupported build approval option.",
            {
              remedy:
                "Use approve-builds to review; approve-builds <name...> or --all explicitly trusts reviewed source code.",
            },
          );
        const selected = parsed.commandArgs.includes("--all")
          ? ["*"]
          : parsed.commandArgs;
        result = await installProject({
          ...tools,
          projectDir: cwd,
          env: options.env,
          reviewBuilds: true,
          ...(selected.length ? { approveBuilds: selected } : {}),
        });
      } else if (command === "rebuild") {
        if (parsed.commandArgs.some((v) => v !== "--offline"))
          throw new ZyrkError(
            "ZYRK_USAGE",
            "Rebuild operates on the complete approved project graph.",
            { remedy: "Use zyrk rebuild [--offline]; review approvals first." },
          );
        result = await installProject({
          ...tools,
          projectDir: cwd,
          env: options.env,
          frozen: true,
          rebuild: true,
          offline: parsed.commandArgs.includes("--offline"),
        });
      } else if (command === "repair") {
        if (parsed.commandArgs.some((arg) => arg !== "--offline"))
          throw new ZyrkError("ZYRK_USAGE", "Repair accepts only --offline.", {
            remedy:
              "Use zyrk repair to rebuild verified instances selected by the lock.",
          });
        result = await installProject({
          ...tools,
          projectDir: cwd,
          env: options.env,
          frozen: true,
          repair: true,
          offline: parsed.commandArgs.includes("--offline"),
        });
      } else
        result = await runMaintenanceCommand({
          command: command as "fetch" | "audit",
          env: options.env,
          args: parsed.commandArgs,
          projectDir: cwd,
          ...tools,
        });
      const payload = (
        command === "audit" ? sanitizeDiagnostic(result) : result
      ) as Record<string, unknown>;
      if (Array.isArray(payload.builds))
        payload.builds = sanitizeDiagnostic(payload.builds);
      if (Array.isArray(payload.buildReviews))
        payload.buildReviews = sanitizeDiagnostic(payload.buildReviews);
      const exitCode =
        payload.status === "unavailable" || payload.thresholdExceeded === true
          ? 1
          : 0;
      if (parsed.json)
        return emit({
          exitCode,
          stdout: `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, ...payload, status: payload.status ?? "ok" })}\n`,
          stderr: "",
        });
      if (command === "approve-builds") {
        const reviews = (payload.buildReviews ?? []) as BuildReview[];
        return emit({
          exitCode,
          stdout: renderBuildReviews(reviews),
          stderr: "",
        });
      }
      return emit({
        exitCode,
        stdout: `${JSON.stringify(payload)}\n`,
        stderr: "",
      });
    } catch (error) {
      return emit(
        fail(toZyrkError(error, `zyrk ${parsed.command} failed.`), parsed),
      );
    }
  }
  if (!parsed.help && !parsed.version && parsed.command === "next") {
    try {
      const result = await runNextCommand({
        args: parsed.commandArgs,
        cwd: options.cwd ?? process.cwd(),
        env: options.env,
      });
      return emit({
        exitCode: 0,
        stdout: parsed.json
          ? JSON.stringify({
              schemaVersion: CLI_JSON_SCHEMA_VERSION,
              command: "next",
              status: "ok",
              ...result,
            }) + "\n"
          : `${result.changed ? "Configured" : "Already configured"} Next Turbopack with the project's strict root and the installed external shared realizations. Experimental additional roots require Next.js 16.4+. Backup: ${result.backup}.\n`,
        stderr: "",
      });
    } catch (error) {
      return emit(
        fail(
          toZyrkError(error, "Next Turbopack configuration failed."),
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
    const progress = createInstallProgress(options.stderr, parsed.json, {
      color: options.env.NO_COLOR === undefined && options.env.TERM !== "dumb",
    });
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
      progress.update({ phase: "planning" });
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
        onProgress: progress.update,
        ...flags,
        env: options.env,
        specs,
        projectDir: cwd,
        ...(options.stdin?.isTTY && options.stderr.isTTY && !parsed.json
          ? {
              requestBuildApproval: (builds: readonly BuildCandidate[]) =>
                promptForBuildApproval(builds, options.stdin!, options.stderr),
            }
          : {}),
        ...tools,
      });
      progress.close(installCompletion(result.readiness));
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
      progress.close();
      return emit(fail(toZyrkError(error, "zyrk install failed."), parsed));
    } finally {
      progress.close();
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
    const progress = createInstallProgress(options.stderr, parsed.json, {
      color: options.env.NO_COLOR === undefined && options.env.TERM !== "dumb",
    });
    try {
      const tools =
        options.tools === undefined
          ? await defaultTools(
              options.env,
              version,
              options.cwd ?? process.cwd(),
            )
          : await options.tools();
      const result = await runDependencyCommand({
        onProgress: progress.update,
        command: parsed.command as DependencyCommand,
        env: options.env,
        args: parsed.commandArgs,
        projectDir: options.cwd ?? process.cwd(),
        store: tools.store,
        registry: tools.registry,
        ...(options.stdin?.isTTY && options.stderr.isTTY && !parsed.json
          ? {
              requestBuildApproval: (builds: readonly BuildCandidate[]) =>
                promptForBuildApproval(builds, options.stdin!, options.stderr),
            }
          : {}),
      });
      progress.close(installCompletion(result.readiness));
      if (parsed.json) {
        return emit({
          exitCode: 0,
          stdout: `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, status: "ok", ...result })}\n`,
          stderr: "",
        });
      }
      return emit({
        exitCode: 0,
        stdout: `Dependency command ${parsed.command} completed: ${result.packages} packages, ${result.reused} realizations reused; ${result.readiness}.\n`,
        stderr: result.warnings.map((w) => `zyrk: ${w}\n`).join(""),
      });
    } catch (error) {
      progress.close();
      return emit(
        fail(toZyrkError(error, `zyrk ${parsed.command} failed.`), parsed),
      );
    } finally {
      progress.close();
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
      const store =
        options.tools === undefined
          ? await Store.open({
              root: resolveStoreRoot({ env: options.env }).root,
              create: false,
            })
          : (await options.tools()).store;
      const result = await runStoreCommand({
        command: parsed.command as "store" | "projects",
        args: parsed.commandArgs,
        store,
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

  // Package scripts are accepted as ergonomic aliases for `zyrk run <name>`.
  // Route through the same project runner so policy, generation leases,
  // local-bin PATH and lifecycle environment stay identical.
  if (
    !parsed.help &&
    !parsed.version &&
    parsed.command !== undefined &&
    !KNOWN_COMMANDS.has(parsed.command) &&
    parsed.argsBeforeCommand.length === 0
  ) {
    const cwd = options.cwd ?? process.cwd();
    const boundary = await findProjectBoundary(cwd);
    if (boundary) {
      let declared = false;
      try {
        const manifest = JSON.parse(
          await readFile(path.join(boundary, "package.json"), "utf8"),
        ) as { scripts?: Record<string, unknown> };
        if (
          manifest.scripts !== null &&
          typeof manifest.scripts === "object" &&
          !Array.isArray(manifest.scripts) &&
          typeof manifest.scripts[parsed.command] === "string"
        )
          declared = true;
      } catch {
        // Preserve the normal unknown-command diagnostic when no valid
        // project script can be identified.
      }
      if (declared) {
        try {
          return await runProjectCommand({
            command: "run",
            args: [parsed.command, ...parsed.commandArgs],
            cwd,
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
    }
  }

  return emit(dispatch(parsed, { version, env: options.env }));
}

async function defaultTools(
  env: NodeJS.ProcessEnv,
  version: string,
  cwd: string = process.cwd(),
): Promise<ToolEnvironment> {
  const registry = await installRegistry({ cwd, env, version });
  const store = await Store.open({
    root: resolveStoreRoot({ env }).root,
    create: true,
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
      ? await defaultTools(options.env, version, options.cwd ?? process.cwd())
      : await options.tools();
  const base = {
    store: tools.store,
    registry: tools.registry,
    args: tail.slice(1),
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
  };
  if (command === "dlx") {
    const result = await runDlx({ ...base, spec: first });
    if (result.exitCode === 0 && options.stderr.isTTY)
      options.stderr.write(
        renderCommandOutput(
          "dlx",
          `zyrk dlx finished ${result.name}@${result.version}.\n`,
          {
            isTTY: true,
            color:
              options.env.NO_COLOR === undefined && options.env.TERM !== "dumb",
          },
        ),
      );
    return result.exitCode;
  }
  const isNext = starterSpecFor(first).startsWith("create-next-app@");
  options.stderr.write(
    isNext
      ? tail.includes("--skip-install")
        ? "zyrk: Next scaffolding only; dependency installation was explicitly skipped.\n"
        : "zyrk: Creating Next.js application; dependencies will install with zyrk.\n"
      : "zyrk: This initializer controls its own dependency installation.\n",
  );
  const progress = createInstallProgress(options.stderr, false, {
    color: options.env.NO_COLOR === undefined && options.env.TERM !== "dumb",
  });
  try {
    const result = await runCreate({
      ...base,
      input: first,
      onInstallProgress: progress.update,
    });
    progress.close(
      result.exitCode === 0
        ? {
            title: "Project created successfully.",
            detail:
              "Open the project directory and run its declared scripts with zyrk.",
          }
        : undefined,
    );
    return result.exitCode;
  } finally {
    progress.close();
  }
}
