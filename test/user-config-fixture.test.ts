import * as path from "node:path";
import * as os from "node:os";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { approveCandidate } from "../src/install/private.ts";
import { pathExists } from "../src/util/fsx.ts";
import { isolateUserConfig } from "./helpers/user-config.ts";

// Exercise Darwin's real mapping even on a Linux developer machine. Only the
// platform selector changes; the production policy reader and checks run intact.
vi.mock("../src/config/paths.ts", async (original) => {
  const actual = await original<typeof import("../src/config/paths.ts")>();
  return {
    ...actual,
    resolveConfigFile: (
      options: Parameters<typeof actual.resolveConfigFile>[0],
    ) => actual.resolveConfigFile({ ...options, platform: "darwin" }),
  };
});
let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
it("writes and enforces the mandatory policy at the macOS home location", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-darwin-policy-"));
  const file = await isolateUserConfig(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ scripts: { deny: ["builder"] } }));
  await expect(
    approveCandidate({
      project: root,
      digest: "reviewed",
      selected: ["*"],
      env: process.env,
      builds: [
        {
          key: "builder@1.0.0",
          name: "builder",
          version: "1.0.0",
          sourceId: "src1_test",
          stages: [{ name: "install", command: "exit 0" }],
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "ZYRK_SCRIPT_BLOCKED" });
  expect(file).toBe(
    path.join(root, "home/Library/Application Support/zyrk/config.json"),
  );
  expect(await pathExists(path.join(root, ".zyrk-local/approvals.json"))).toBe(
    false,
  );
});
