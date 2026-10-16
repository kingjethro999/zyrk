import * as os from "node:os";
import * as path from "node:path";
import { pathExists } from "../util/fsx.ts";

/**
 * Platform placement (SPEC 7.1) and store root resolution.
 *
 * These are design defaults implemented as real code paths; nothing here is a
 * reference to files that must already exist.
 */

export type PlatformPaths = {
  /** Directory holding the managed store's parent (`.../snpm/store/v1`). */
  storeRoot: string;
  /** User configuration file. */
  configFile: string;
};

export type StoreRootResolution = {
  root: string;
  source: "default" | "env-override";
  overrideVariable?: string;
};

export const STORE_DIR_ENV = "SNPM_STORE_DIR";

export function platformPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): PlatformPaths {
  if (platform === "win32") {
    const localAppData =
      env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
    const appData = env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
    return {
      storeRoot: path.join(localAppData, "snpm", "store", "v1"),
      configFile: path.join(appData, "snpm", "config.json"),
    };
  }
  if (platform === "darwin") {
    const support = path.join(home, "Library", "Application Support");
    return {
      storeRoot: path.join(support, "snpm", "store", "v1"),
      configFile: path.join(support, "snpm", "config.json"),
    };
  }
  const dataHome =
    env["XDG_DATA_HOME"] !== undefined && env["XDG_DATA_HOME"] !== ""
      ? env["XDG_DATA_HOME"]
      : path.join(home, ".local", "share");
  const configHome =
    env["XDG_CONFIG_HOME"] !== undefined && env["XDG_CONFIG_HOME"] !== ""
      ? env["XDG_CONFIG_HOME"]
      : path.join(home, ".config");
  return {
    storeRoot: path.join(dataHome, "snpm", "store", "v1"),
    configFile: path.join(configHome, "snpm", "config.json"),
  };
}

export function resolveStoreRoot(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
  } = {},
): StoreRootResolution {
  const env = options.env ?? process.env;
  const override = env[STORE_DIR_ENV];
  if (override !== undefined && override !== "") {
    return {
      root: path.resolve(override),
      source: "env-override",
      overrideVariable: STORE_DIR_ENV,
    };
  }
  const defaults = platformPaths(
    env,
    options.platform ?? process.platform,
    options.home ?? os.homedir(),
  );
  return { root: defaults.storeRoot, source: "default" };
}

/** Config file location for the current environment. */
export function resolveConfigFile(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
  } = {},
): string {
  const env = options.env ?? process.env;
  return platformPaths(
    env,
    options.platform ?? process.platform,
    options.home ?? os.homedir(),
  ).configFile;
}

/**
 * Find the project boundary starting at `cwd`: the nearest ancestor that has
 * a `package.json`. Workspace-aware boundaries arrive with the resolver
 * milestone; this function answers "which directory does a command act on".
 */
export async function findProjectBoundary(
  startDir: string,
): Promise<string | null> {
  let current = path.resolve(startDir);
  for (;;) {
    if (await pathExists(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
