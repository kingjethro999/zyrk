import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { installWorkspaceProject } from "../src/install/workspace-install.ts";
import { readWorkspaceLock } from "../src/install/workspace-lock.ts";
import { runProjectCommand } from "../src/commands/project.ts";
import { runDeployCommand } from "../src/commands/deploy.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";
import { startStubRegistry } from "./helpers/registry-stub.ts";

async function fixture(incompatibleDev = false) {
  const root = await mkdtemp(path.join(tmpdir(), "zyrk-workspace-platform-"));
  const server = await startStubRegistry([
    ...["runtime", "dev-only"].map((name) => ({
      name,
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: "module.exports=1" } },
        },
      ],
    })),
  ]);
  const projectDir = path.join(root, "app");
  await mkdir(path.join(projectDir, "packages/member"), { recursive: true });
  await writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      workspaces: ["packages/*"],
      files: ["app.cjs"],
      dependencies: { runtime: "1.0.0" },
      ...(incompatibleDev ? { devDependencies: { "dev-only": "1.0.0" } } : {}),
    }),
  );
  await writeFile(
    path.join(projectDir, "packages/member/package.json"),
    JSON.stringify({
      name: "member",
      version: "1.0.0",
      ...(incompatibleDev ? { devDependencies: { "dev-only": "1.0.0" } } : {}),
    }),
  );
  await writeFile(
    path.join(projectDir, "app.cjs"),
    'console.log(require("runtime"))',
  );
  const registry = new RegistryClient({
    registry: server.url,
    userAgent: "test",
    retries: 0,
  });
  if (incompatibleDev) {
    const original = registry.packument.bind(registry);
    vi.spyOn(registry, "packument").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] === "dev-only")
        result.versions["1.0.0"]!.os = [`!${process.platform}`];
      return result;
    });
  }
  const store = await Store.open({
    root: path.join(root, "store"),
    create: true,
  });
  return {
    root,
    projectDir,
    registry,
    store,
    async cleanup() {
      vi.restoreAllMocks();
      await server.close();
      await rmrfNoFollow(root);
    },
  };
}
it("validates legacy workspace schemas before discarding their platform-pruned graph", async () => {
  const f = await fixture();
  try {
    await installWorkspaceProject(f);
    const file = path.join(f.projectDir, "package-lock.json");
    const doc = JSON.parse(await readFile(file, "utf8"));
    delete doc.zyrk.platformPolicy;
    for (const mutate of [
      (d: typeof doc) => {
        d.zyrk.contextCanonicalization = 999;
      },
      (d: typeof doc) => {
        d.zyrk.unknownField = true;
      },
      (d: typeof doc) => {
        d.zyrk.workspaceGraph.nodes[0].edges = [
          { name: "missing", target: "absent", kind: "prod", spec: "1" },
        ];
      },
    ]) {
      const malformed = structuredClone(doc);
      mutate(malformed);
      await writeFile(file, JSON.stringify(malformed));
      await expect(
        readWorkspaceLock(f.projectDir, undefined, undefined, true),
      ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
    }
    await writeFile(file, JSON.stringify(doc));
    expect(
      await readWorkspaceLock(f.projectDir, undefined, undefined, true),
    ).toBeNull();
    await expect(readWorkspaceLock(f.projectDir)).rejects.toMatchObject({
      code: "ZYRK_LOCK_MISMATCH",
    });
  } finally {
    await f.cleanup();
  }
});
it("omits incompatible workspace dev roots before platform selection and keeps them in the lock", async () => {
  const f = await fixture(true);
  try {
    await expect(
      installWorkspaceProject({ ...f, omitDev: true }),
    ).resolves.toMatchObject({ readiness: "ready" });
    const file = path.join(f.projectDir, "package-lock.json");
    const bytes = await readFile(file, "utf8");
    expect(bytes).toContain('"name": "dev-only"');
    expect(
      await pathExists(path.join(f.projectDir, "node_modules/dev-only")),
    ).toBe(false);
    expect(
      await pathExists(
        path.join(f.projectDir, "packages/member/node_modules/dev-only"),
      ),
    ).toBe(false);
    await installWorkspaceProject({ ...f, omitDev: true, frozen: true });
    expect(await readFile(file, "utf8")).toBe(bytes);
    const env = { ...process.env, ZYRK_STORE_DIR: f.store.root };
    let listed = "";
    await runProjectCommand({
      command: "list",
      args: [],
      cwd: f.projectDir,
      env,
      json: true,
      stdout: {
        write(s) {
          listed += s;
        },
      },
      stderr: { write() {} },
    });
    expect(
      JSON.parse(listed).nodes.map((n: { name: string }) => n.name),
    ).not.toContain("dev-only");
    await runDeployCommand({
      command: "deploy",
      args: ["--out", path.join(f.root, "runtime"), "--entry", "app.cjs"],
      cwd: f.projectDir,
      env,
      stdout: { write() {} },
      stderr: { write() {} },
    });
    await expect(
      installWorkspaceProject({ ...f, frozen: true }),
    ).rejects.toMatchObject({ code: "ZYRK_PLATFORM_UNSUPPORTED" });
    expect(await readFile(file, "utf8")).toBe(bytes);
  } finally {
    await f.cleanup();
  }
});
