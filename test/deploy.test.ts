import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  readdir,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, it, expect } from "vitest";
import { runDeployCommand } from "../src/commands/deploy.ts";
import { installProject } from "../src/install/run.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { sha512HexOfFile } from "../src/util/hash.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";
const exec = promisify(execFile);
let root: string,
  project: string,
  store: Store,
  server: StubRegistry,
  stdout: string,
  stderr: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-deploy-"));
  project = path.join(root, "app");
  await mkdir(project);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  server = await startStubRegistry([
    {
      name: "alpha",
      versions: [
        {
          version: "1.0.0",
          deps: { beta: "1.0.0" },
          files: { "index.js": { data: 'module.exports=require("beta");' } },
        },
      ],
    },
    {
      name: "beta",
      versions: [
        {
          version: "1.0.0",
          files: {
            "index.js": { data: 'module.exports="runtime-beta";' },
            "asset.txt": { data: "runtime asset" },
          },
        },
      ],
    },
    {
      name: "dev-only",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: 'module.exports="dev";' } },
        },
      ],
    },
  ]);
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "example",
      version: "1.0.0",
      files: ["server.cjs", "views"],
      scripts: { start: "node server.cjs" },
      dependencies: { alpha: "1.0.0" },
      devDependencies: { beta: "1.0.0", "dev-only": "1.0.0" },
    }),
  );
  await mkdir(path.join(project, "views"));
  await writeFile(path.join(project, "views/page.html"), "asset");
  await writeFile(
    path.join(project, "server.cjs"),
    'console.log(require("alpha"), require("fs").readFileSync("views/page.html","utf8"));',
  );
  await installProject({
    projectDir: project,
    store,
    registry: new RegistryClient({
      registry: server.url,
      userAgent: "zyrk-test/0",
      retries: 0,
    }),
  });
  stdout = "";
  stderr = "";
});
afterEach(async () => {
  await server.close();
  await rmrfNoFollow(root);
});
function run(
  command: "deploy" | "docker",
  args: string[],
  env: NodeJS.ProcessEnv = {},
) {
  return runDeployCommand({
    command,
    args,
    cwd: project,
    env: { ...process.env, ZYRK_STORE_DIR: store.root, ...env },
    stdout: {
      write: (s) => {
        stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        stderr += s;
      },
    },
  });
}
it("exports a self-contained production closure including assets and runtime transitive dev roots", async () => {
  const out = path.join(root, "runtime");
  expect(await run("deploy", ["--out", out, "--omit=dev"])).toBe(0);
  const deployment = JSON.parse(
    await readFile(path.join(out, "zyrk-deploy.json"), "utf8"),
  );
  expect(deployment.packages).toBe(2);
  expect(await readdir(path.join(out, "node_modules"))).not.toContain(
    "dev-only",
  );
  expect(
    JSON.parse(await readFile(path.join(out, "package.json"), "utf8"))
      .devDependencies,
  ).toBeUndefined();
  await rmrfNoFollow(store.root);
  await rmrfNoFollow(project);
  const result = await exec(process.execPath, ["server.cjs"], {
    cwd: out,
    env: { PATH: process.env.PATH },
  });
  expect(result.stdout.trim()).toBe("runtime-beta asset");
  expect(stdout).not.toContain(store.root);
});
it("refuses existing outputs, output/input overlap and credential file selection without changing them", async () => {
  const out = path.join(root, "existing");
  await mkdir(out);
  await writeFile(path.join(out, "keep"), "unchanged");
  await expect(run("deploy", ["--out", out])).rejects.toMatchObject({
    code: "ZYRK_USAGE",
  });
  expect(await readFile(path.join(out, "keep"), "utf8")).toBe("unchanged");
  await expect(run("deploy", ["--out", project])).rejects.toMatchObject({
    code: "ZYRK_DEPLOY_ESCAPE",
  });
  await writeFile(path.join(project, ".env"), "TOKEN=secret");
  await expect(
    run("deploy", [
      "--out",
      path.join(root, "credentials"),
      "--files",
      ".env",
      "--files",
      "server.cjs",
    ]),
  ).rejects.toMatchObject({ code: "ZYRK_POLICY_DENIED" });
});
it("refuses application symlinks and escaping output parents", async () => {
  await symlink(path.join(root, "outside"), path.join(project, "views/leak"));
  await expect(
    run("deploy", ["--out", path.join(root, "runtime")]),
  ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_ESCAPE" });
  await symlink(root, path.join(root, "alias"));
  await expect(
    run("deploy", ["--out", path.join(root, "alias/runtime2")]),
  ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_ESCAPE" });
});
it("requires explicit production selection and validates a direct runtime entry", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(project, "package.json"), "utf8"),
  );
  delete manifest.files;
  await writeFile(path.join(project, "package.json"), JSON.stringify(manifest));
  await expect(
    run("deploy", ["--out", path.join(root, "runtime")]),
  ).rejects.toMatchObject({ code: "ZYRK_USAGE" });
  await expect(
    run("deploy", ["--out", path.join(root, "runtime"), "--files", "views"]),
  ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_NONRELOCATABLE" });
});
it("generates pinned Docker inputs with isolated fetch/build and refuses overwrites", async () => {
  await mkdir(path.join(project, ".zyrk-tooling"));
  const artifact = path.join(project, ".zyrk-tooling/cli.tgz");
  await writeFile(artifact, "test artifact");
  const digest = await sha512HexOfFile(artifact);
  const args = [
    "init",
    "--node-image",
    "node:24-bookworm-slim@sha256:" + "a".repeat(64),
    "--cli-artifact",
    ".zyrk-tooling/cli.tgz",
    "--cli-sha512",
    digest,
    "--port",
    "8080",
  ];
  expect(await run("docker", args)).toBe(0);
  const dockerfile = await readFile(path.join(project, "Dockerfile"), "utf8");
  expect(dockerfile).toContain("sha512sum --check");
  expect(dockerfile).toContain("--network=none");
  expect(dockerfile).toContain('CMD ["node","server.cjs"]');
  expect(dockerfile).toContain("USER node");
  expect(dockerfile).toContain("EXPOSE 8080");
  expect(await readFile(path.join(project, ".dockerignore"), "utf8")).toContain(
    "**/.npmrc",
  );
  const guide = await readFile(path.join(project, "ZYRK_DOCKER.md"), "utf8");
  expect(guide).toContain(
    "Relocatable JavaScript output from ready private generations is supported",
  );
  expect(guide).toContain(
    "Live workspace runtime closures and a restricted Linux ELF64 N-API",
  );
  await expect(run("docker", args)).rejects.toMatchObject({
    code: "ZYRK_USAGE",
  });
  expect(await readFile(path.join(project, "Dockerfile"), "utf8")).toBe(
    dockerfile,
  );
});
it("reports a missing Docker executable and propagates an explicit local Docker child status", async () => {
  await writeFile(
    path.join(project, "zyrk-docker.json"),
    JSON.stringify({ schemaVersion: 1, port: 3000 }),
  );
  await expect(
    run("docker", ["build", "--tag", "app:local"], {
      PATH: path.join(root, "empty"),
    }),
  ).rejects.toMatchObject({ code: "ZYRK_BUILD_FAILED" });
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "docker"),
    '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 19\n',
    { mode: 0o755 },
  );
  expect(
    await run("docker", ["run", "--tag", "app:local", "--port", "8080"], {
      PATH: bin,
    }),
  ).toBe(19);
  expect(stdout).toContain("8080:3000");
});
it("rejects writing portable output into the managed store", async () => {
  await expect(
    run("deploy", ["--out", path.join(store.root, "runtime")]),
  ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_ESCAPE" });
});
