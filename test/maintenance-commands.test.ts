import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, it, expect } from "vitest";
import { runMaintenanceCommand } from "../src/commands/maintenance.ts";
import { installProject } from "../src/install/run.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";

let root: string,
  project: string,
  store: Store,
  registry: RegistryClient,
  backend: StubRegistry,
  server: Server;
let posted: unknown[], response: unknown, responseCode: number;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-maintenance-"));
  project = path.join(root, "app");
  await mkdir(project);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  backend = await startStubRegistry([
    {
      name: "alpha",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: "module.exports = 1;" } },
        },
      ],
    },
    {
      name: "built",
      versions: [
        {
          version: "1.0.0",
          scripts: { postinstall: "touch script-ran" },
          files: { "index.js": { data: "module.exports = 1;" } },
        },
      ],
    },
  ]);
  posted = [];
  response = {};
  responseCode = 200;
  let registryUrl = "";
  server = createServer(async (req, res) => {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      posted.push({
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      res.writeHead(responseCode, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }
    const fetched = await fetch(new URL(req.url ?? "/", backend.url));
    const type =
      fetched.headers.get("content-type") ?? "application/octet-stream";
    res.writeHead(fetched.status, { "content-type": type });
    if (type.includes("json"))
      res.end(
        (await fetched.text()).replaceAll(
          backend.url.replace(/\/$/, ""),
          registryUrl.replace(/\/$/, ""),
        ),
      );
    else res.end(Buffer.from(await fetched.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  registryUrl = `http://127.0.0.1:${address.port}/`;
  registry = new RegistryClient({
    registry: registryUrl,
    userAgent: "zyrk-test",
    retries: 0,
  });
  await manifest();
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await backend.close();
  await rmrfNoFollow(root);
});
async function manifest(extra: Record<string, unknown> = {}) {
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "private-project",
      version: "1.0.0",
      dependencies: { alpha: "1.0.0" },
      ...extra,
    }),
  );
}
function install(lockfileOnly = false) {
  return installProject({ projectDir: project, store, registry, lockfileOnly });
}
function command(command: "audit" | "fetch" | "repair", ...args: string[]) {
  return runMaintenanceCommand({
    command,
    args,
    projectDir: project,
    store,
    registry,
  });
}

it("sends deduplicated exact package names and versions only to the configured registry", async () => {
  await manifest({
    dependencies: { alpha: "1.0.0", alternate: "npm:alpha@1.0.0" },
  });
  await install(true);
  response = {
    alpha: [
      {
        severity: "high",
        title: "Fixture advisory",
        url: "https://example.test/advisory/1",
        vulnerable_versions: "<2",
      },
    ],
  };
  const before = await readFile(
    path.join(project, "package-lock.json"),
    "utf8",
  );
  const result = await command("audit", "--audit-level", "high");
  expect(result).toMatchObject({
    kind: "audit",
    status: "complete",
    thresholdExceeded: true,
    advisories: [{ name: "alpha", version: "1.0.0", severity: "high" }],
  });
  expect(posted).toEqual([
    { url: "/-/npm/v1/security/advisories/bulk", body: { alpha: ["1.0.0"] } },
  ]);
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    before,
  );
  expect(await pathExists(path.join(project, "node_modules"))).toBe(false);
});
it("distinguishes disabled and offline unknown results and sends nothing", async () => {
  await manifest({ zyrk: { audit: { enabled: false, failOn: "high" } } });
  expect(await command("audit")).toMatchObject({ status: "disabled" });
  await manifest();
  expect(await command("audit", "--offline")).toMatchObject({
    status: "unavailable",
    advisories: [],
  });
  expect(posted).toEqual([]);
});
it("distinguishes no known advisories from failed or malformed service responses", async () => {
  await install(true);
  expect(await command("audit")).toMatchObject({
    status: "complete",
    thresholdExceeded: false,
    advisories: [],
  });
  responseCode = 503;
  expect(await command("audit")).toMatchObject({ status: "unavailable" });
  responseCode = 200;
  response = {
    alpha: [
      {
        severity: "high",
        title: "bad",
        url: "https://example.test/1",
        vulnerable_versions: "not semver",
      },
    ],
  };
  expect(await command("audit")).toMatchObject({ status: "unavailable" });
});
it("filters advisory ranges and respects the configured severity threshold", async () => {
  await manifest({ zyrk: { audit: { enabled: true, failOn: "critical" } } });
  await install(true);
  response = {
    alpha: [
      {
        severity: "critical",
        title: "unaffected",
        url: "https://example.test/1",
        vulnerable_versions: ">=2",
      },
      {
        severity: "moderate",
        title: "affected",
        url: "https://example.test/2",
        vulnerable_versions: "1.x",
      },
    ],
  };
  expect(await command("audit")).toMatchObject({
    status: "complete",
    thresholdExceeded: false,
    advisories: [{ title: "affected" }],
  });
  expect(await command("audit", "--audit-level=moderate")).toMatchObject({
    thresholdExceeded: true,
  });
});
it("rejects missing or drifted locks and unknown policy before sending information", async () => {
  await expect(command("audit")).rejects.toMatchObject({
    code: "ZYRK_LOCK_MISMATCH",
  });
  await install(true);
  await manifest({ dependencies: { alpha: "^2" } });
  await expect(command("audit")).rejects.toMatchObject({
    code: "ZYRK_LOCK_MISMATCH",
  });
  await manifest({ zyrk: { audit: { enabeld: false } } });
  await expect(command("audit")).rejects.toMatchObject({
    code: "ZYRK_POLICY_DENIED",
  });
  expect(posted).toEqual([]);
});
it("prefetches locked sources without projection, lock edits, or lifecycle execution", async () => {
  await manifest({ dependencies: { built: "1.0.0" } });
  await install(true);
  const before = await readFile(
    path.join(project, "package-lock.json"),
    "utf8",
  );
  expect(await command("fetch", "--frozen-lockfile")).toMatchObject({
    readiness: "fetched",
    packages: 1,
  });
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    before,
  );
  expect(await pathExists(path.join(project, "node_modules"))).toBe(false);
  expect(
    await command("fetch", "--frozen-lockfile", "--offline"),
  ).toMatchObject({ readiness: "fetched" });
  expect(posted).toEqual([]);
});
it("rejects unsupported maintenance arguments and repair without a lock", async () => {
  await expect(command("fetch")).rejects.toMatchObject({ code: "ZYRK_USAGE" });
  await expect(command("audit", "fix")).rejects.toMatchObject({
    code: "ZYRK_USAGE",
  });
  await expect(command("audit", "--audit-level=invalid")).rejects.toMatchObject(
    { code: "ZYRK_USAGE" },
  );
  await expect(command("repair")).rejects.toMatchObject({
    code: "ZYRK_LOCK_MISMATCH",
  });
  expect(posted).toEqual([]);
});
