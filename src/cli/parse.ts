/**
 * Minimal argv parsing for the snpm CLI (SPEC 15).
 *
 * snpm takes no global configuration file of its own here: flags are parsed
 * per invocation. `--json` anywhere before the `--` separator selects the
 * machine-readable envelope. Everything after `--` belongs to the requested
 * user command (SPEC 15.3.1: flags following the separator for `run`/`exec`
 * remain user arguments, never snpm options).
 */

export type ParsedArgs = {
  help: boolean;
  version: boolean;
  /** The requested command, or undefined when none was given. */
  command: string | undefined;
  /** Everything that is not the command, `--json`, or `--help`/`--version`. */
  commandArgs: string[];
  /** Raw tokens after the command token, verbatim, for npm delegation. */
  argsAfterCommand: string[];
  json: boolean;
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    version: false,
    command: undefined,
    commandArgs: [],
    argsAfterCommand: [],
    json: false,
  };
  let separator = false;
  let commandIndex = -1;
  argv.forEach((token, index) => {
    if (separator) {
      parsed.commandArgs.push(token);
      return;
    }
    if (token === "--") {
      separator = true;
      parsed.commandArgs.push(token);
      return;
    }
    if (token === "--json") {
      parsed.json = true;
      return;
    }
    if (
      parsed.command === undefined &&
      (token === "--help" || token === "-h")
    ) {
      parsed.help = true;
      return;
    }
    if (
      parsed.command === undefined &&
      (token === "--version" || token === "-v")
    ) {
      parsed.version = true;
      return;
    }
    if (parsed.command === undefined && !token.startsWith("-")) {
      parsed.command = token;
      commandIndex = index;
      return;
    }
    parsed.commandArgs.push(token);
  });
  if (commandIndex >= 0) parsed.argsAfterCommand = argv.slice(commandIndex + 1);
  return parsed;
}

/** Commands whose global-install mode snpm rejects (SPEC 15.3.1, 22.3). */
const GLOBAL_INSTALL_COMMANDS = new Set(["install", "i", "add"]);

/**
 * Detect global-install mode before any work happens.
 *
 * Exact tokens `-g` and `--global` in any position, plus the `--global=true`
 * spelling, select global mode; `install`/`add` take no `--` payload, so
 * tokens after a separator are still snpm's. Explicit local selections
 * (`--no-global`, `--global=false`) do not trigger. snpm defines no
 * configuration that selects global-install mode, so the only remaining
 * channel is the environment npm itself documents: `npm_config_global=true`
 * is honored as a fail-safe, never as a silent conversion.
 */
export function isGlobalInstallRequest(
  command: string,
  commandArgs: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (!GLOBAL_INSTALL_COMMANDS.has(command)) return false;
  if (env.npm_config_global === "true") return true;
  return commandArgs.some(
    (token) =>
      token === "-g" || token === "--global" || token === "--global=true",
  );
}
