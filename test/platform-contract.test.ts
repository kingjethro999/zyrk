import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { platformPaths, resolveStoreRoot } from "../src/config/paths.ts";
import { Store } from "../src/store/layout.ts";
import { platformOmissionSummary } from "../src/install/platform.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
const exec = promisify(execFile);
it("summarizes expected platform-specific optional dependencies without a warning per package", () => {
  expect(
    platformOmissionSummary([
      { name: "@tool/native-linux" },
      { name: "@tool/native-darwin" },
      { name: "@tool/native-linux" },
    ]),
  ).toBe(
    "Skipped 3 platform-specific optional dependencies across 2 package variants; this is expected when selecting dependencies for the current platform.",
  );
  expect(platformOmissionSummary([])).toBeUndefined();
});
it("selects platform-specific per-user store and configuration paths", () => {
  const home = path.resolve("fixture home ü");
  for (const platform of ["linux", "darwin", "win32"] as const) {
    const paths = platformPaths({}, platform, home);
    expect(paths.storeRoot).toContain(home);
    expect(paths.storeRoot).toContain("zyrk");
    expect(paths.configFile).not.toBe(paths.storeRoot);
    expect(resolveStoreRoot({ env: {}, platform, home }).root).toBe(
      paths.storeRoot,
    );
  }
});
it("runs CLI help/version and rejects global requests before store access", async () => {
  const bin = path.resolve("bin/zyrk.js");
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  expect((await exec(process.execPath, [bin, "--version"])).stdout.trim()).toBe(
    version,
  );
  expect((await exec(process.execPath, [bin, "--help"])).stdout).toContain(
    "Usage: zyrk",
  );
  try {
    await exec(process.execPath, [bin, "install", "--global", "--json"], {
      env: {
        ...process.env,
        ZYRK_STORE_DIR: path.resolve("absent store must not open"),
      },
    });
    throw new Error("unexpected success");
  } catch (error) {
    expect(JSON.parse((error as { stdout: string }).stdout).code).toBe(
      "ZYRK_GLOBAL_INSTALL_UNSUPPORTED",
    );
  }
});
it.skipIf(process.platform !== "win32")(
  "refuses Windows stores until ACL isolation is verified",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zyrk ACL gate ü-"));
    try {
      await expect(
        Store.open({ root: path.join(root, "store"), create: true }),
      ).rejects.toMatchObject({ code: "ZYRK_PLATFORM_UNSUPPORTED" });
    } finally {
      await rmrfNoFollow(root);
    }
  },
);
