import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  unlink,
  symlink,
} from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { beforeEach, afterEach, it, expect } from "vitest";
import { runProjectCommand } from "../src/commands/project.ts";
import { installProject } from "../src/install/run.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { openStoreDb } from "../src/store/db.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";
let root: string, project: string, store: Store, server: StubRegistry;
let stdout: string, stderr: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-project-"));
  project = path.join(root, "project");
  await mkdir(project);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  server = await startStubRegistry([
    {
      name: "alpha",
      versions: [
        {
          version: "1.0.0",
          deps: { beta: "1.0.0" },
          bin: { alpha: "cli.js" },
          files: {
            "index.js": { data: "module.exports=1;" },
            "cli.js": {
              data: "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));",
              mode: 0o755,
            },
          },
        },
      ],
    },
    {
      name: "beta",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: "module.exports=2;" } },
        },
      ],
    },
  ]);
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: { alpha: "1.0.0" },
      scripts: {
        precheck: "exit 99",
        check: "node check.cjs",
        postcheck: "exit 98",
        fail: 'node -e "process.exit(17)"',
        signal: "node -e \"process.kill(process.pid,'SIGTERM')\"",
      },
    }),
  );
  await writeFile(
    path.join(project, "check.cjs"),
    `console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),event:process.env.npm_lifecycle_event,init:process.env.INIT_CWD,manifest:process.env.npm_package_json,exec:process.env.npm_execpath,agent:process.env.npm_config_user_agent,alpha:require('alpha')}));`,
  );
  await installProject({
    projectDir: project,
    store,
    registry: new RegistryClient({
      registry: server.url,
      retries: 0,
      userAgent: "zyrk-test/0",
    }),
  });
  stdout = "";
  stderr = "";
});
afterEach(async () => {
  await server.close();
  await rmrfNoFollow(root);
});
async function run(
  command: string,
  args: string[] = [],
  extraEnv: NodeJS.ProcessEnv = {},
  json = false,
) {
  stdout = "";
  stderr = "";
  return runProjectCommand({
    command,
    args,
    cwd: project,
    env: {
      ...process.env,
      ZYRK_STORE_DIR: store.root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      ...extraEnv,
    },
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
    json,
  });
}
it("runs only the named script, quotes arguments, sets npm environment and releases its generation lease", async () => {
  expect(
    await run("run", ["check", "--", "hello world", "'; exit 90; '"]),
  ).toBe(0);
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({
    cwd: project,
    args: ["hello world", "'; exit 90; '"],
    event: "check",
    init: project,
    manifest: path.join(project, "package.json"),
    alpha: 1,
  });
  expect(result.agent).toMatch(/^zyrk\//);
  expect(result.exec).toMatch(/bin\/zyrk.js$/);
  const db = openStoreDb(store.paths.dbFile);
  try {
    const leases = db.prepare("SELECT state,scope_json FROM leases").all();
    expect(
      leases.some(
        (row) =>
          row.state === "released" &&
          JSON.parse(String(row.scope_json)).generationId,
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});
it("executes only installed local bins and forwards arguments without a shell", async () => {
  expect(await run("exec", ["alpha", "one two", "$(exit 5)"])).toBe(0);
  expect(JSON.parse(stdout)).toEqual(["one two", "$(exit 5)"]);
  await expect(
    run("exec", ["node", "-e", "process.exit(0)"]),
  ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
  await expect(run("exec", ["../alpha"])).rejects.toMatchObject({
    code: "ZYRK_USAGE",
  });
});
it("propagates command exit status and child termination", async () => {
  expect(await run("run", ["fail"])).toBe(17);
  expect(await run("run", ["signal"])).toBe(143);
});
it("lists transitive graph edges and explains the selecting parent without disclosing store paths", async () => {
  expect(await run("list", [], {}, true)).toBe(0);
  const graph = JSON.parse(stdout);
  expect(graph.nodes.map((n: { name: string }) => n.name).sort()).toEqual([
    "alpha",
    "beta",
  ]);
  expect(stdout).not.toContain(root);
  expect(await run("why", ["beta"], {}, true)).toBe(0);
  expect(JSON.parse(stdout).nodes[0].requiredBy).toHaveLength(1);
  await expect(run("why", ["missing"])).rejects.toMatchObject({
    code: "ZYRK_RESOLUTION_FAILED",
  });
});
it("doctor detects dropped zyrk lock metadata, broken links and ambient resolution flags", async () => {
  expect(
    await run(
      "doctor",
      [],
      { NODE_PATH: "/ambient", NODE_OPTIONS: "--preserve-symlinks" },
      true,
    ),
  ).toBe(0);
  expect(JSON.parse(stdout).diagnostics).toHaveLength(2);
  await unlink(path.join(project, "node_modules/alpha"));
  await symlink(
    path.join(root, "missing"),
    path.join(project, "node_modules/alpha"),
  );
  expect(await run("doctor", [], {}, true)).toBe(1);
  expect(stdout).toContain("Installed dependency link");
  const lock = JSON.parse(
    await readFile(path.join(project, "package-lock.json"), "utf8"),
  );
  delete lock.zyrk;
  await writeFile(
    path.join(project, "package-lock.json"),
    JSON.stringify(lock),
  );
  expect(await run("doctor", [], {}, true)).toBe(1);
  expect(stdout).toContain("ZYRK_LOCK_MISMATCH");
  expect(stdout).not.toContain(root);
});
it("fails closed for configured user execution policy and missing script names", async () => {
  await mkdir(path.join(root, "config/zyrk"), { recursive: true });
  await writeFile(
    path.join(root, "config/zyrk/config.json"),
    JSON.stringify({ scripts: { deny: ["check"] } }),
  );
  await expect(run("run", ["check"])).rejects.toMatchObject({
    code: "ZYRK_POLICY_DENIED",
  });
});
