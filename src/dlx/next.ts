/** create-next-app's documented --skip-install keeps installation native.
 * Target validation prevents a successful-but-aborted initializer from making
 * zyrk install an unrelated project. No generated files are deleted on failure.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { satisfies } from "semver";
import { adaptNextDisplay } from "./next-display.ts";
import { ZyrkError } from "../errors.ts";
import { installProject, type InstallOptions } from "../install/run.ts";
import { isErrno } from "../util/fsx.ts";
import { runInitializer, type DlxOptions, type DlxResult } from "./run.ts";

function failed(message: string): ZyrkError {
  return new ZyrkError("ZYRK_RESOLUTION_FAILED", message, {
    remedy:
      "Check the generated project, then run zyrk install there; rerun create with an explicit project directory when needed.",
  });
}

/** Value-bearing options from the official create-next-app CLI. All original
 * arguments are still forwarded verbatim; these only locate the target. */
function parseNextArgs(args: readonly string[]): {
  target: string | undefined;
  flags: Set<string>;
} {
  const values = new Set([
    "--import-alias",
    "--example",
    "-e",
    "--example-path",
  ]);
  const flags = new Set<string>();
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      target ??= args[i + 1]?.trim();
      break;
    }
    if (values.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) flags.add(arg);
    else target ??= arg.trim();
  }
  return { target, flags };
}

export function nextTarget(args: readonly string[]): string | undefined {
  return parseNextArgs(args).target;
}

async function info(file: string) {
  try {
    return await lstat(file);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return undefined;
    throw cause;
  }
}

async function manifestExists(directory: string): Promise<boolean> {
  return (await info(path.join(directory, "package.json"))) !== undefined;
}

async function verifyManifest(directory: string): Promise<void> {
  const file = path.join(directory, "package.json");
  const entry = await info(file);
  if (!entry?.isFile() || entry.isSymbolicLink())
    throw failed(
      "Next initializer did not generate a regular project manifest.",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw failed("Next initializer generated an unreadable project manifest.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw failed("Next initializer generated an invalid project manifest.");
  const manifest = raw as Record<string, unknown>;
  const deps = manifest.dependencies;
  if (
    typeof manifest.name !== "string" ||
    !manifest.name ||
    typeof deps !== "object" ||
    deps === null ||
    Array.isArray(deps) ||
    typeof (deps as Record<string, unknown>).next !== "string" ||
    !(deps as Record<string, unknown>).next
  )
    throw failed("Next initializer did not generate a Next project manifest.");
}

export async function runNextInitializer(
  options: DlxOptions & { onInstallProgress?: InstallOptions["onProgress"] },
): Promise<DlxResult> {
  const args = options.args ?? [];
  const { target, flags } = parseNextArgs(args);
  // Help/version/reset are valid successful commands that generate no app.
  if (
    [...flags].some((arg) =>
      [
        "--help",
        "-h",
        "--version",
        "-v",
        "--reset",
        "--reset-preferences",
      ].includes(arg),
    )
  )
    return runInitializer(options);
  const cwd = options.cwd ?? process.cwd();
  const explicit = target === undefined ? undefined : path.resolve(cwd, target);
  const before = explicit === undefined ? undefined : await info(explicit);
  if (
    before !== undefined &&
    (!before.isDirectory() || before.isSymbolicLink())
  )
    throw failed("Next initializer target must be a real project directory.");
  if (explicit !== undefined && (await manifestExists(explicit)))
    throw failed("Next initializer target already has a project manifest.");
  const entries =
    explicit === undefined ? new Set(await readdir(cwd)) : undefined;
  const skipInstall = flags.has("--skip-install");
  if (
    !skipInstall &&
    [...flags].some((flag) =>
      ["--use-npm", "--use-pnpm", "--use-yarn", "--use-bun"].includes(flag),
    )
  )
    throw new ZyrkError(
      "ZYRK_USAGE",
      "Cannot select another dependency installer for zyrk create next-app.",
      {
        remedy:
          "Remove --use-npm/--use-pnpm/--use-yarn/--use-bun to install with zyrk, or pass --skip-install to scaffold only.",
      },
    );
  // Insert before -- so it remains an option when the user supplies a literal target.
  const forwarded = [...args];
  if (!skipInstall) {
    const separator = forwarded.indexOf("--");
    forwarded.splice(
      separator < 0 ? forwarded.length : separator,
      0,
      "--skip-install",
    );
  }
  const result = await runInitializer(
    {
      ...options,
      args: forwarded,
      validateTool(tool) {
        options.validateTool?.(tool);
        if (!satisfies(tool.version, ">=15.0.0 <17.0.0"))
          throw new ZyrkError(
            "ZYRK_RESOLUTION_FAILED",
            "The resolved Next initializer version has no verified skip-install adapter.",
            {
              detail: { name: tool.name, version: tool.version },
              remedy:
                "Select create-next-app 15.x or 16.x; the native create adapter requires the verified --skip-install contract.",
            },
          );
      },
    },
    async ({ script, version }) =>
      adaptNextDisplay(script, version, skipInstall),
  );
  if (result.exitCode !== 0) return result;
  let directory = explicit;
  if (directory === undefined) {
    const generated: string[] = [];
    for (const entry of await readdir(cwd)) {
      if (entries!.has(entry)) continue;
      const candidate = path.join(cwd, entry);
      const current = await info(candidate);
      if (
        current?.isDirectory() &&
        !current.isSymbolicLink() &&
        (await manifestExists(candidate))
      )
        generated.push(candidate);
    }
    if (generated.length !== 1)
      throw failed(
        "Cannot identify one generated Next project after the initializer exited.",
      );
    directory = generated[0]!;
  }
  const after = await info(directory);
  if (
    !after?.isDirectory() ||
    after.isSymbolicLink() ||
    (before !== undefined &&
      (before.dev !== after.dev || before.ino !== after.ino))
  )
    throw failed("Next initializer did not preserve its project directory.");
  await verifyManifest(directory);
  if (!skipInstall)
    await installProject({
      projectDir: directory,
      store: options.store,
      registry: options.registry,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.onInstallProgress === undefined
        ? {}
        : { onProgress: options.onInstallProgress }),
    });
  return result;
}
