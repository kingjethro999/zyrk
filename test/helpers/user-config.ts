import * as path from "node:path";
import { mkdir } from "node:fs/promises";
import { vi } from "vitest";
import { resolveConfigFile } from "../../src/config/paths.ts";

/** Isolate every supported user-config location without touching the real home. */
export async function isolateUserConfig(root: string): Promise<string> {
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "config"));
  vi.stubEnv("APPDATA", path.join(home, "AppData", "Roaming"));
  vi.stubEnv("LOCALAPPDATA", path.join(home, "AppData", "Local"));
  return resolveConfigFile();
}
