/** Parse dependency edits; the installer owns resolution and atomic publication. */
import npa from "npm-package-arg";
import { ZyrkError } from "../errors.ts";
import type { RegistryClient } from "../fetch/registry.ts";
import type { Store } from "../store/layout.ts";
import { packageName } from "../install/lock.ts";
import {
  installProject,
  type InstallOptions,
  type InstallResult,
} from "../install/run.ts";

export type DependencyCommand = "add" | "remove" | "update" | "import";

function usage(command: DependencyCommand, reason: string): ZyrkError {
  return new ZyrkError(
    "ZYRK_USAGE",
    `Cannot ${command} dependencies: ${reason}.`,
    {
      remedy:
        "Use add <spec...>, remove <name...>, update [--latest] [name...], or import --from npm; review zyrk --help for supported options.",
    },
  );
}

export async function runDependencyCommand(options: {
  command: DependencyCommand;
  args: readonly string[];
  projectDir: string;
  store: Store;
  registry: RegistryClient;
}): Promise<InstallResult> {
  const { command } = options;
  const install: InstallOptions = {
    projectDir: options.projectDir,
    store: options.store,
    registry: options.registry,
  };
  const names: string[] = [];
  let from: string | undefined;
  let latest = false;
  let positional = false;
  for (let i = 0; i < options.args.length; i++) {
    const arg = options.args[i]!;
    if (!positional && arg === "--") {
      positional = true;
      continue;
    }
    if (!positional && arg.startsWith("-")) {
      switch (arg) {
        case "-D":
        case "--save-dev":
          if (command !== "add")
            throw usage(command, "--save-dev is only valid for add");
          install.saveDev = true;
          break;
        case "-O":
        case "--save-optional":
          if (command !== "add")
            throw usage(command, "--save-optional is only valid for add");
          install.saveOptional = true;
          break;
        case "-E":
        case "--save-exact":
          if (command !== "add" && command !== "update")
            throw usage(
              command,
              "--save-exact is only valid for add or update",
            );
          install.saveExact = true;
          break;
        case "--latest":
          if (command !== "update")
            throw usage(command, "--latest is only valid for update");
          latest = true;
          break;
        case "--ignore-scripts":
          install.ignoreScripts = true;
          break;
        case "--lockfile-only":
          install.lockfileOnly = true;
          break;
        case "--from":
          if (command !== "import" || from !== undefined)
            throw usage(command, "unexpected --from option");
          from = options.args[++i];
          if (from === undefined) throw usage(command, "--from requires npm");
          break;
        default:
          if (
            arg.startsWith("--from=") &&
            command === "import" &&
            from === undefined
          ) {
            from = arg.slice(7);
            break;
          }
          if (
            command === "add" &&
            ["-g", "--global", "--global=true"].includes(arg)
          )
            throw new ZyrkError(
              "ZYRK_GLOBAL_INSTALL_UNSUPPORTED",
              "Cannot install global dependencies through zyrk.",
              { remedy: "Run npm install --global directly instead." },
            );
          throw usage(command, "an unsupported option was supplied");
      }
    } else names.push(arg);
  }
  if (install.saveDev && install.saveOptional)
    throw usage(command, "development and optional dependency groups conflict");
  switch (command) {
    case "add":
      if (!names.length)
        throw usage(command, "at least one package specification is required");
      for (const name of names) {
        try {
          const parsed = npa(name);
          if (
            !parsed.name ||
            !packageName(parsed.name) ||
            !["version", "range", "tag", "alias"].includes(parsed.type)
          )
            throw new Error("unsupported");
        } catch {
          throw usage(command, "a registry package specification is invalid");
        }
      }
      install.specs = names;
      break;
    case "remove":
    case "update":
      if (command === "remove" && !names.length)
        throw usage(command, "at least one direct dependency name is required");
      if (names.some((name) => !packageName(name)))
        throw usage(
          command,
          "expected direct dependency names without versions",
        );
      install.mutation =
        command === "remove" ? { remove: names } : { update: names, latest };
      break;
    case "import":
      if (from !== "npm" || names.length)
        throw usage(
          command,
          "import requires --from npm and no package arguments",
        );
      install.importNpm = true;
      break;
  }
  return installProject(install);
}
