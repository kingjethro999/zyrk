import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { beforeEach, afterEach, expect, it } from "vitest";
import { runCli } from "../src/cli/main.ts";
import { Store } from "../src/store/layout.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
let root: string,
  project: string,
  store: Store,
  registry: RegistryClient,
  server: StubRegistry;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-ws-cli-"));
  project = path.join(root, "project");
  await mkdir(path.join(project, "packages/app"), { recursive: true });
  await mkdir(path.join(project, "packages/lib"));
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "root",
      version: "1.0.0",
      workspaces: ["packages/*"],
      dependencies: { app: "workspace:*", pure: "1.0.0" },
    }),
  );
  await writeFile(
    path.join(project, "packages/app/package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { lib: "workspace:*" },
      scripts: {
        check: "node -e 'console.log(require(\"lib\"))'",
        ordered:
          'node -e \'require("fs").appendFileSync(process.env.ORDER_FILE,"app\\n")\'',
      },
    }),
  );
  await writeFile(
    path.join(project, "packages/lib/package.json"),
    JSON.stringify({
      name: "lib",
      version: "1.0.0",
      bin: { "lib-cli": "cli.cjs" },
      scripts: {
        ordered:
          'node -e \'require("fs").appendFileSync(process.env.ORDER_FILE,"lib\\n")\'',
      },
    }),
  );
  await writeFile(
    path.join(project, "packages/app/index.js"),
    'module.exports=require("lib");',
  );
  await writeFile(
    path.join(project, "packages/lib/index.js"),
    'module.exports="live-library";',
  );
  await writeFile(
    path.join(project, "packages/lib/cli.cjs"),
    'console.log("workspace-bin");',
  );
  server = await startStubRegistry([
    {
      name: "pure",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: "module.exports=42;" } },
        },
      ],
    },
  ]);
  registry = new RegistryClient({ registry: server.url, userAgent: "test" });
  store = await Store.open({ root: path.join(root, "store"), create: true });
});
afterEach(async () => {
  await server.close();
  await rmrfNoFollow(root);
});
async function cli(argv: string[], cwd = project) {
  let out = "",
    err = "";
  const code = await runCli({
    argv,
    cwd,
    env: {
      ...process.env,
      ZYRK_STORE_DIR: store.root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      ORDER_FILE: path.join(root, "order.txt"),
    },
    tools: async () => ({ store, registry }),
    stdout: {
      write: (s) => {
        out += s;
      },
    },
    stderr: {
      write: (s) => {
        err += s;
      },
    },
  });
  return { code, out, err };
}
it("routes workspace install, importer inspection, named scripts and local executables", async () => {
  expect((await cli(["install"])).code).toBe(0);
  const listed = await cli(["--json", "list", "--workspace", "app"]);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.out).workspaces[0].nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "lib",
        source: "workspace:packages/lib",
      }),
    ]),
  );
  expect((await cli(["run", "--workspace=app", "check"])).out.trim()).toBe(
    "live-library",
  );
  expect(
    (await cli(["exec", "--workspace", "packages/app", "lib-cli"])).out.trim(),
  ).toBe("workspace-bin");
  const doctor = await cli(["doctor"], path.join(project, "packages/app"));
  expect(doctor.code).toBe(0);
  expect((await cli(["run", "--recursive", "ordered"])).code).toBe(0);
  expect(await readFile(path.join(root, "order.txt"), "utf8")).toBe(
    "lib\napp\n",
  );
});
it("prefetches the authoritative closure from a child and does not disclose live package names to audit", async () => {
  expect((await cli(["install", "--lockfile-only"])).code).toBe(0);
  const before = await readFile(
    path.join(project, "package-lock.json"),
    "utf8",
  );
  expect(
    (
      await cli(
        ["fetch", "--frozen-lockfile"],
        path.join(project, "packages/app"),
      )
    ).code,
  ).toBe(0);
  let posted: Readonly<Record<string, readonly string[]>> = {};
  registry.auditAdvisories = async (packages) => {
    posted = packages;
    return {};
  };
  const audit = await cli(
    ["--json", "audit"],
    path.join(project, "packages/app"),
  );
  expect(audit.code).toBe(0);
  expect(JSON.parse(audit.out).status).toBe("complete");
  expect(posted).toEqual({ pure: ["1.0.0"] });
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    before,
  );
  expect(
    (
      await cli(
        ["install", "--frozen-lockfile", "--offline"],
        path.join(project, "packages/app"),
      )
    ).code,
  ).toBe(0);
  const target = await realpath(path.join(project, "node_modules/pure"));
  expect(target.startsWith(store.paths.realizationsDir)).toBe(true);
});
it("rejects workspace membership drift and unknown exact filters before executing", async () => {
  expect((await cli(["install"])).code).toBe(0);
  expect((await cli(["run", "--workspace", "not-app", "check"])).code).toBe(1);
  const file = path.join(project, "packages/lib/package.json");
  const value = JSON.parse(await readFile(file, "utf8"));
  value.version = "2.0.0";
  await writeFile(file, JSON.stringify(value));
  const listed = await cli(
    ["--json", "list"],
    path.join(project, "packages/app"),
  );
  expect(listed.code).toBe(1);
  expect(JSON.parse(listed.out).code).toBe("ZYRK_LOCK_MISMATCH");
});
