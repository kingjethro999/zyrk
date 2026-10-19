import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installProject } from "../src/install/run.ts";
import { installWorkspaceProject } from "../src/install/workspace-install.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";
import { startStubRegistry } from "./helpers/registry-stub.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

for (const adoption of [false, true])
  for (const workspace of [false, true])
    it(`keeps one portable ${workspace ? "workspace" : "standalone"} lock across Linux and Windows selections${adoption ? " after npm adoption" : ""}`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "zyrk-portable-"));
      cleanups.push(() => rmrfNoFollow(root));
      const server = await startStubRegistry([
        {
          name: "wrapper",
          versions: [
            {
              version: "1.0.0",
              optionalDeps: { linux: "1.0.0", windows: "1.0.0" },
              files: { "index.js": { data: "module.exports=1" } },
            },
          ],
        },
        ...["linux", "windows"].map((name) => ({
          name,
          versions: [
            {
              version: "1.0.0",
              deps: { [`${name}-child`]: "1.0.0" },
              files: { "index.js": { data: "module.exports=1" } },
            },
          ],
        })),
        ...["linux-child", "windows-child"].map((name) => ({
          name,
          versions: [
            {
              version: "1.0.0",
              files: { "index.js": { data: "module.exports=1" } },
            },
          ],
        })),
      ]);
      cleanups.push(() => server.close());
      const registry = new RegistryClient({
        registry: server.url,
        userAgent: "test",
        retries: 0,
      });
      const original = registry.packument.bind(registry);
      vi.spyOn(registry, "packument").mockImplementation(async (...args) => {
        const metadata = await original(...args);
        if (args[0] === "linux" || args[0] === "windows")
          metadata.versions["1.0.0"]!.os = [
            args[0] === "linux" ? "linux" : "win32",
          ];
        return metadata;
      });
      const projectDir = path.join(root, "app");
      await mkdir(projectDir);
      await writeFile(
        path.join(projectDir, "package.json"),
        JSON.stringify({
          name: "app",
          version: "1.0.0",
          dependencies: { wrapper: "1.0.0" },
          ...(workspace ? { workspaces: ["packages/*"] } : {}),
        }),
      );
      if (workspace) {
        await mkdir(path.join(projectDir, "packages", "member"), {
          recursive: true,
        });
        await writeFile(
          path.join(projectDir, "packages/member/package.json"),
          JSON.stringify({ name: "member", version: "1.0.0" }),
        );
      }
      const store = await Store.open({
        root: path.join(root, "store"),
        create: true,
      });
      const install = workspace ? installWorkspaceProject : installProject;
      await install({
        projectDir,
        registry,
        store,
        platform: { os: "linux", cpu: "x64", libc: "glibc" },
      });
      const lockPath = path.join(projectDir, "package-lock.json");
      let bytes = await readFile(lockPath, "utf8");
      if (adoption) {
        const npm = JSON.parse(bytes);
        delete npm.zyrk;
        const pruned = structuredClone(npm);
        for (const location of Object.keys(pruned.packages))
          if (location.includes("/node_modules/windows"))
            delete pruned.packages[location];
        const prunedBytes = JSON.stringify(pruned);
        await writeFile(lockPath, prunedBytes);
        await expect(
          install({
            projectDir,
            registry,
            store,
            importNpm: true,
            platform: { os: "linux", cpu: "x64", libc: "glibc" },
          }),
        ).rejects.toMatchObject({
          code: "ZYRK_LOCK_MISMATCH",
          message: expect.stringContaining("optional selection"),
        });
        expect(await readFile(lockPath, "utf8")).toBe(prunedBytes);
        expect(
          await pathExists(path.join(projectDir, "node_modules/wrapper")),
        ).toBe(true);
        await writeFile(lockPath, JSON.stringify(npm));
        await install({
          projectDir,
          registry,
          store,
          importNpm: true,
          platform: { os: "linux", cpu: "x64", libc: "glibc" },
        });
        bytes = await readFile(lockPath, "utf8");
      }
      expect(bytes).toContain('"platformPolicy": "portable-optional/1"');
      expect(bytes).toContain('"windows-child"');
      expect(bytes).not.toContain(root);
      await install({
        projectDir,
        registry,
        store,
        frozen: true,
        platform: { os: "win32", cpu: "x64" },
      });
      expect(await readFile(lockPath, "utf8")).toBe(bytes);
      const wrapper = await import("node:fs/promises").then((fs) =>
        fs.realpath(path.join(projectDir, "node_modules/wrapper")),
      );
      expect(await pathExists(path.join(wrapper, "../windows"))).toBe(true);
      expect(await pathExists(path.join(wrapper, "../linux"))).toBe(false);
      await install({
        projectDir,
        registry,
        store,
        platform: { os: "win32", cpu: "x64" },
      });
      expect(await readFile(lockPath, "utf8")).toBe(bytes);
      const manifestPath = path.join(projectDir, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.dependencies.linux = "1.0.0";
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(
        install({
          projectDir,
          registry,
          store,
          platform: { os: "win32", cpu: "x64" },
        }),
      ).rejects.toMatchObject({ code: "ZYRK_PLATFORM_UNSUPPORTED" });
      expect(await readFile(lockPath, "utf8")).toBe(bytes);
      delete manifest.dependencies.linux;
      await writeFile(manifestPath, JSON.stringify(manifest));
      const doc = JSON.parse(bytes);
      delete doc.zyrk.platformPolicy;
      await writeFile(lockPath, JSON.stringify(doc));
      await expect(
        install({ projectDir, registry, store, frozen: true }),
      ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
      await install({
        projectDir,
        registry,
        store,
        platform: { os: "linux", cpu: "x64", libc: "glibc" },
      });
      expect(await readFile(lockPath, "utf8")).toContain(
        '"platformPolicy": "portable-optional/1"',
      );
    });
