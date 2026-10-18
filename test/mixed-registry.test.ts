import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";
import { installRegistry } from "../src/install/registry.ts";
import { Store } from "../src/store/layout.ts";
import { installProject } from "../src/install/run.ts";
import { runDlx } from "../src/dlx/run.ts";
import { runMaintenanceCommand } from "../src/commands/maintenance.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
const exec = promisify(execFile);
const roots: string[] = [];
const servers: StubRegistry[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(roots.splice(0).map((r) => rmrfNoFollow(r)));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zyrk-mixed-"));
  roots.push(root);
  const project = path.join(root, "app");
  await mkdir(project);
  const pub = await startStubRegistry([
    {
      name: "public-helper",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: 'module.exports="public";' } },
        },
      ],
    },
  ]);
  servers.push(pub);
  const priv = await startStubRegistry([
    {
      name: "@private/tool",
      versions: [
        {
          version: "1.0.0",
          deps: { "public-helper": "1.0.0" },
          bin: { tool: "cli.js" },
          files: {
            "index.js": {
              data: 'module.exports="private:"+require("public-helper");',
            },
            "cli.js": { data: 'console.log(require("./index.js"));' },
          },
        },
      ],
    },
  ]);
  servers.push(priv);
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { "@private/tool": "1.0.0" },
    }),
  );
  await writeFile(
    path.join(project, ".npmrc"),
    `registry=${pub.url}\n@private:registry=${priv.url}\n`,
  );
  const registry = await installRegistry({
    cwd: project,
    env: { HOME: root },
    version: "test",
  });
  const store = await Store.open({
    root: path.join(root, "store"),
    create: true,
  });
  return { root, project, pub, priv, registry, store };
}
it("installs mixed scoped and public closures with correct origins and frozen offline reuse", async () => {
  const f = await fixture();
  await installProject({
    projectDir: f.project,
    store: f.store,
    registry: f.registry,
  });
  expect(
    (
      await exec(
        process.execPath,
        ["-e", 'console.log(require("@private/tool"))'],
        { cwd: f.project },
      )
    ).stdout.trim(),
  ).toBe("private:public");
  const lock = JSON.parse(
    await readFile(path.join(f.project, "package-lock.json"), "utf8"),
  );
  const nodes = Object.values(lock.zyrk.nodes) as {
    name: string;
    origin: string;
  }[];
  expect(nodes.find((n) => n.name === "@private/tool")?.origin).toBe(
    f.priv.origin,
  );
  expect(nodes.find((n) => n.name === "public-helper")?.origin).toBe(
    f.pub.origin,
  );
  await installProject({
    projectDir: f.project,
    store: f.store,
    registry: f.registry,
    frozen: true,
    offline: true,
  });
  await writeFile(
    path.join(f.project, ".npmrc"),
    `registry=${f.pub.url}\n@private:registry=${f.pub.url}\n`,
  );
  const changed = await installRegistry({
    cwd: f.project,
    env: { HOME: f.root },
    version: "test",
  });
  await expect(
    installProject({
      projectDir: f.project,
      store: f.store,
      registry: changed,
      frozen: true,
      offline: true,
    }),
  ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
});
it("partitions advisory requests by source registry without disclosing private names to public", async () => {
  const f = await fixture();
  await installProject({
    projectDir: f.project,
    store: f.store,
    registry: f.registry,
  });
  const posted: Array<{
    origin: string;
    packages: Readonly<Record<string, readonly string[]>>;
  }> = [];
  for (const name of ["public-helper", "@private/tool"]) {
    const client = f.registry.forPackage(name);
    client.auditAdvisories = async (packages) => {
      posted.push({ origin: client.origin, packages });
      return {};
    };
  }
  expect(
    await runMaintenanceCommand({
      command: "audit",
      args: [],
      projectDir: f.project,
      store: f.store,
      registry: f.registry,
    }),
  ).toMatchObject({ kind: "audit" });
  expect(posted).toHaveLength(2);
  expect(posted.find((p) => p.origin === f.pub.origin)?.packages).toEqual({
    "public-helper": ["1.0.0"],
  });
  expect(posted.find((p) => p.origin === f.priv.origin)?.packages).toEqual({
    "@private/tool": ["1.0.0"],
  });
});
it("keeps mixed registry workspace graphs valid through frozen offline installs", async () => {
  const f = await fixture();
  await mkdir(path.join(f.project, "packages/member"), { recursive: true });
  await writeFile(
    path.join(f.project, "package.json"),
    JSON.stringify({
      name: "root",
      private: true,
      version: "1.0.0",
      workspaces: ["packages/*"],
    }),
  );
  await writeFile(
    path.join(f.project, "packages/member/package.json"),
    JSON.stringify({
      name: "member",
      version: "1.0.0",
      dependencies: { "@private/tool": "1.0.0" },
    }),
  );
  await installProject({
    projectDir: f.project,
    registry: f.registry,
    store: f.store,
  });
  await installProject({
    projectDir: path.join(f.project, "packages/member"),
    registry: f.registry,
    store: f.store,
    frozen: true,
    offline: true,
  });
  expect(
    (
      await exec(
        process.execPath,
        ["-e", 'console.log(require("@private/tool"))'],
        { cwd: path.join(f.project, "packages/member") },
      )
    ).stdout.trim(),
  ).toBe("private:public");
});
it("adopts exact mixed npm selections without assigning every source the default origin", async () => {
  const f = await fixture();
  const privateVersion = (await f.registry.packument("@private/tool")).versions[
    "1.0.0"
  ]!;
  const publicVersion = (await f.registry.packument("public-helper")).versions[
    "1.0.0"
  ]!;
  await writeFile(
    path.join(f.project, "package-lock.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "app",
          version: "1.0.0",
          dependencies: { "@private/tool": "1.0.0" },
        },
        "node_modules/@private/tool": {
          version: "1.0.0",
          resolved: privateVersion.dist.tarball,
          integrity: privateVersion.dist.integrity,
          dependencies: { "public-helper": "1.0.0" },
          bin: privateVersion.bin,
        },
        "node_modules/public-helper": {
          version: "1.0.0",
          resolved: publicVersion.dist.tarball,
          integrity: publicVersion.dist.integrity,
        },
      },
    }),
  );
  await installProject({
    projectDir: f.project,
    store: f.store,
    registry: f.registry,
    importNpm: true,
  });
  expect(
    (
      await exec(
        process.execPath,
        ["-e", 'console.log(require("@private/tool"))'],
        { cwd: f.project },
      )
    ).stdout.trim(),
  ).toBe("private:public");
});
it("executes scoped tools with their public transitive dependencies through the same routing adapter", async () => {
  const f = await fixture();
  const result = await runDlx({
    cwd: f.project,
    store: f.store,
    registry: f.registry,
    spec: "@private/tool@1.0.0",
    capture: true,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("private:public");
});
it("exports selected mixed-origin production graphs without contacting or exposing another registry", async () => {
  const f = await fixture();
  await installProject({
    projectDir: f.project,
    store: f.store,
    registry: f.registry,
  });
  await writeFile(
    path.join(f.project, "app.cjs"),
    'console.log(require("@private/tool"));',
  );
  const { runDeployCommand } = await import("../src/commands/deploy.ts");
  const output = path.join(f.root, "runtime");
  await runDeployCommand({
    command: "deploy",
    args: ["--out", output, "--files", "app.cjs", "--entry", "app.cjs"],
    cwd: f.project,
    env: { ...process.env, ZYRK_STORE_DIR: f.store.root },
    stdout: { write() {} },
    stderr: { write() {} },
  });
  await rmrfNoFollow(f.store.root);
  await rmrfNoFollow(f.project);
  expect(
    (await exec(process.execPath, ["app.cjs"], { cwd: output })).stdout.trim(),
  ).toBe("private:public");
});
it("routes npm aliases by the real scoped package rather than the public alias name", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { alias: "npm:@private/tool@1.0.0" },
    }),
  );
  await installProject({
    projectDir: f.project,
    store: f.store,
    registry: f.registry,
  });
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("alias"))'], {
        cwd: f.project,
      })
    ).stdout.trim(),
  ).toBe("private:public");
});
it("refuses an unpartitioned mixed advisory request before sending any names", async () => {
  const f = await fixture();
  await expect(
    f.registry.auditAdvisories({
      "@private/tool": ["1.0.0"],
      "public-helper": ["1.0.0"],
    }),
  ).rejects.toMatchObject({ code: "ZYRK_POLICY_DENIED" });
});
it("rejects altered local registry routing before creating a portable export", async () => {
  const f = await fixture();
  await installProject({
    projectDir: f.project,
    store: f.store,
    registry: f.registry,
  });
  await writeFile(
    path.join(f.project, "app.cjs"),
    'console.log(require("@private/tool"));',
  );
  const stateFile = path.join(
      f.project,
      "node_modules/.zyrk/install-state.json",
    ),
    state = JSON.parse(await readFile(stateFile, "utf8"));
  state.registryConfig.registries["@private"] = f.pub.origin;
  await writeFile(stateFile, JSON.stringify(state));
  const { runDeployCommand } = await import("../src/commands/deploy.ts");
  await expect(
    runDeployCommand({
      command: "deploy",
      args: [
        "--out",
        path.join(f.root, "runtime"),
        "--files",
        "app.cjs",
        "--entry",
        "app.cjs",
      ],
      cwd: f.project,
      env: { ...process.env, ZYRK_STORE_DIR: f.store.root },
      stdout: { write() {} },
      stderr: { write() {} },
    }),
  ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
});
it("adopts and exports a mixed-registry npm workspace closure with exact live links", async () => {
  const f = await fixture();
  await mkdir(path.join(f.project, "packages/member"), { recursive: true });
  const rootManifest = {
      name: "app",
      version: "1.0.0",
      workspaces: ["packages/*"],
      dependencies: { member: "*" },
    },
    member = {
      name: "member",
      version: "1.0.0",
      dependencies: { "@private/tool": "1.0.0" },
    };
  await writeFile(
    path.join(f.project, "package.json"),
    JSON.stringify(rootManifest),
  );
  await writeFile(
    path.join(f.project, "packages/member/package.json"),
    JSON.stringify(member),
  );
  await writeFile(
    path.join(f.project, "packages/member/index.js"),
    'module.exports=require("@private/tool");',
  );
  await writeFile(
    path.join(f.project, "app.cjs"),
    'console.log(require("member"));',
  );
  const p = (await f.registry.packument("@private/tool")).versions["1.0.0"]!,
    q = (await f.registry.packument("public-helper")).versions["1.0.0"]!;
  await writeFile(
    path.join(f.project, "package-lock.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": rootManifest,
        "packages/member": member,
        "node_modules/member": { link: true, resolved: "packages/member" },
        "node_modules/@private/tool": {
          version: "1.0.0",
          resolved: p.dist.tarball,
          integrity: p.dist.integrity,
          dependencies: { "public-helper": "1.0.0" },
          bin: p.bin,
        },
        "node_modules/public-helper": {
          version: "1.0.0",
          resolved: q.dist.tarball,
          integrity: q.dist.integrity,
        },
      },
    }),
  );
  await installProject({
    projectDir: f.project,
    store: f.store,
    registry: f.registry,
    importNpm: true,
  });
  await installProject({
    projectDir: f.project,
    store: f.store,
    registry: f.registry,
    frozen: true,
    offline: true,
  });
  const { runDeployCommand } = await import("../src/commands/deploy.ts"),
    out = path.join(f.root, "runtime");
  await runDeployCommand({
    command: "deploy",
    args: ["--out", out, "--files", "app.cjs", "--entry", "app.cjs"],
    cwd: f.project,
    env: { ...process.env, ZYRK_STORE_DIR: f.store.root },
    stdout: { write() {} },
    stderr: { write() {} },
  });
  await rmrfNoFollow(f.project);
  await rmrfNoFollow(f.store.root);
  expect(
    (await exec(process.execPath, ["app.cjs"], { cwd: out })).stdout.trim(),
  ).toBe("private:public");
});
