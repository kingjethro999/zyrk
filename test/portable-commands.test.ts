import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { runDeployCommand } from "../src/commands/deploy.ts";
import { runProjectCommand } from "../src/commands/project.ts";
import { installProject } from "../src/install/run.ts";
import { installWorkspaceProject } from "../src/install/workspace-install.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";
import { startStubRegistry } from "./helpers/registry-stub.ts";
const exec = promisify(execFile);
for (const workspace of [false, true])
  it(`exports and inspects only the installed platform closure (${workspace ? "workspace" : "standalone"})`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zyrk-portable-commands-"));
    const server = await startStubRegistry([
      {
        name: "wrapper",
        versions: [
          {
            version: "1.0.0",
            optionalDeps: { active: "1.0.0", inactive: "1.0.0" },
            files: { "index.js": { data: 'module.exports=require("active")' } },
          },
        ],
      },
      ...["active", "inactive"].map((name) => ({
        name,
        versions: [
          {
            version: "1.0.0",
            files: { "index.js": { data: 'module.exports="active-result"' } },
          },
        ],
      })),
    ]);
    try {
      const registry = new RegistryClient({
        registry: server.url,
        userAgent: "test",
        retries: 0,
      });
      const original = registry.packument.bind(registry);
      vi.spyOn(registry, "packument").mockImplementation(async (...args) => {
        const metadata = await original(...args);
        if (args[0] === "inactive")
          metadata.versions["1.0.0"]!.os = [`!${process.platform}`];
        return metadata;
      });
      const project = path.join(root, "app");
      await mkdir(project);
      await writeFile(
        path.join(project, "package.json"),
        JSON.stringify({
          name: "app",
          version: "1.0.0",
          files: ["app.cjs"],
          dependencies: { wrapper: "1.0.0" },
          ...(workspace ? { workspaces: ["packages/*"] } : {}),
        }),
      );
      await writeFile(
        path.join(project, "app.cjs"),
        'console.log(require("wrapper"))',
      );
      if (workspace) {
        await mkdir(path.join(project, "packages/member"), { recursive: true });
        await writeFile(
          path.join(project, "packages/member/package.json"),
          JSON.stringify({ name: "member", version: "1.0.0" }),
        );
      }
      const store = await Store.open({
        root: path.join(root, "store"),
        create: true,
      });
      await (workspace ? installWorkspaceProject : installProject)({
        projectDir: project,
        registry,
        store,
      });
      const lockBytes = await readFile(
        path.join(project, "package-lock.json"),
        "utf8",
      );
      const lock = JSON.parse(lockBytes);
      const inactive = workspace
        ? lock.zyrk.workspaceGraph.nodes.find(
            (n: { name: string }) => n.name === "inactive",
          ).sourceId
        : (Object.values(lock.zyrk.nodes).find(
            (n) => (n as { name: string }).name === "inactive",
          ) as { source: string });
      const inactiveId = workspace ? inactive : inactive.source;
      expect(
        await pathExists(
          path.join(store.paths.sourcesDir, inactiveId, "manifest.json"),
        ),
      ).toBe(false);
      const env = { ...process.env, ZYRK_STORE_DIR: store.root };
      const inspect = async (command: string, args: string[] = []) => {
        let text = "";
        const code = await runProjectCommand({
          command,
          args,
          cwd: project,
          env,
          json: true,
          stdout: {
            write(s) {
              text += s;
            },
          },
          stderr: { write() {} },
        });
        return { code, result: JSON.parse(text) };
      };
      const listed = await inspect("list");
      expect(listed.result.nodes.map((n: { name: string }) => n.name)).toEqual(
        expect.arrayContaining(["wrapper", "active"]),
      );
      expect(
        listed.result.nodes.map((n: { name: string }) => n.name),
      ).not.toContain("inactive");
      await expect(inspect("why", ["inactive"])).rejects.toMatchObject({
        code: "ZYRK_RESOLUTION_FAILED",
      });
      expect((await inspect("doctor")).code).toBe(0);
      const out = path.join(root, "runtime");
      await runDeployCommand({
        command: "deploy",
        args: ["--out", out, "--entry", "app.cjs"],
        cwd: project,
        env,
        stdout: { write() {} },
        stderr: { write() {} },
      });
      expect(
        await readFile(path.join(project, "package-lock.json"), "utf8"),
      ).toBe(lockBytes);
      expect(
        await pathExists(
          path.join(store.paths.sourcesDir, inactiveId, "manifest.json"),
        ),
      ).toBe(false);
      await rmrfNoFollow(project);
      await rmrfNoFollow(store.root);
      expect(
        (
          await exec(process.execPath, ["app.cjs"], {
            cwd: out,
            env: { PATH: process.env.PATH },
          })
        ).stdout.trim(),
      ).toBe("active-result");
    } finally {
      vi.restoreAllMocks();
      await server.close();
      await rmrfNoFollow(root);
    }
  });
