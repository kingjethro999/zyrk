import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installProject } from "../src/install/run.ts";
import { runDependencyCommand } from "../src/commands/dependencies.ts";
import {
  computeDependencyPlan,
  computeDirectPlan,
  computePackagesPlan,
  renderPlanSummary,
} from "../src/install/plan.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";

describe("computeDirectPlan", () => {
  it("reports added, updated, and removed direct dependencies per group", () => {
    const plan = computeDirectPlan(
      {
        dependencies: { alpha: "1.0.0", beta: "1.0.0" },
        devDependencies: { vitest: "1.0.0" },
      },
      {
        dependencies: { alpha: "2.0.0", gamma: "1.0.0" },
        devDependencies: {},
      },
    );
    expect(plan.added).toEqual([
      { name: "gamma", to: "1.0.0", group: "dependencies" },
    ]);
    expect(plan.updated).toEqual([
      { name: "alpha", from: "1.0.0", to: "2.0.0", group: "dependencies" },
    ]);
    expect(plan.removed).toEqual([
      { name: "beta", from: "1.0.0", group: "dependencies" },
      { name: "vitest", from: "1.0.0", group: "devDependencies" },
    ]);
  });

  it("returns empty diffs for identical manifests", () => {
    const manifest = { dependencies: { alpha: "^1.0.0" } };
    const plan = computeDirectPlan(manifest, { ...manifest });
    expect(plan.added).toEqual([]);
    expect(plan.updated).toEqual([]);
    expect(plan.removed).toEqual([]);
  });
});

describe("computePackagesPlan", () => {
  it("diffs resolved package versions by name", () => {
    const plan = computePackagesPlan(
      [
        { name: "alpha", version: "1.0.0" },
        { name: "beta", version: "1.0.0" },
      ],
      [
        { name: "alpha", version: "2.0.0" },
        { name: "gamma", version: "1.0.0" },
      ],
    );
    expect(plan.added).toEqual([{ name: "gamma", to: "1.0.0" }]);
    expect(plan.updated).toEqual([
      { name: "alpha", from: "1.0.0", to: "2.0.0" },
    ]);
    expect(plan.removed).toEqual([{ name: "beta", from: "1.0.0" }]);
  });
});

describe("renderPlanSummary", () => {
  it("states plainly when nothing changes and emits no color escapes", () => {
    const text = renderPlanSummary(
      computeDependencyPlan({
        originalManifest: { dependencies: { alpha: "1.0.0" } },
        proposedManifest: { dependencies: { alpha: "1.0.0" } },
        priorNodes: [{ name: "alpha", version: "1.0.0" }],
        resolvedNodes: [{ name: "alpha", version: "1.0.0" }],
      }),
      { color: false },
    );
    expect(text).toContain("No dependency changes proposed");
    expect(text).not.toContain("\u001b[");
  });
});

let root: string,
  project: string,
  store: Store,
  server: StubRegistry,
  registry: RegistryClient;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-install-plan-"));
  project = path.join(root, "app");
  await mkdir(project);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  server = await startStubRegistry([
    {
      name: "alpha",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: 'module.exports="one";' } },
        },
        {
          version: "1.1.0",
          files: { "index.js": { data: 'module.exports="minor";' } },
        },
      ],
      tags: { latest: "1.1.0" },
    },
    {
      name: "gamma",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: 'module.exports="gamma";' } },
        },
      ],
      tags: { latest: "1.0.0" },
    },
  ]);
  registry = new RegistryClient({
    registry: server.url,
    userAgent: "zyrk-test/0",
    retries: 0,
  });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: { alpha: "^1.0.0" },
    }),
  );
});
afterEach(async () => {
  await server.close();
  await rmrfNoFollow(root);
});

function install(extra: Partial<Parameters<typeof installProject>[0]> = {}) {
  return installProject({ projectDir: project, store, registry, ...extra });
}
async function lockText() {
  return readFile(path.join(project, "package-lock.json"), "utf8");
}
async function manifestText() {
  return readFile(path.join(project, "package.json"), "utf8");
}

it("plan mode resolves a preview without writing the lock or manifest", async () => {
  const lockBefore = await lockText().catch(() => null);
  const manifestBefore = await manifestText();
  const result = await install({ plan: true });
  expect(result.readiness).toBe("plan");
  expect(result.plan).toBeDefined();
  expect(result.plan!.direct.added).toEqual([]);
  expect(result.plan!.packages.added).toEqual([{ name: "alpha", to: "1.1.0" }]);
  // Nothing on disk may change for a plan.
  expect(await lockText().catch(() => null)).toBe(lockBefore);
  expect(await manifestText()).toBe(manifestBefore);
});

it("plan mode after install reports an empty diff", async () => {
  await install();
  const result = await install({ plan: true });
  expect(result.readiness).toBe("plan");
  expect(result.plan!.direct.added).toEqual([]);
  expect(result.plan!.direct.updated).toEqual([]);
  expect(result.plan!.direct.removed).toEqual([]);
  expect(result.plan!.packages.added).toEqual([]);
  expect(result.plan!.packages.updated).toEqual([]);
  expect(result.plan!.packages.removed).toEqual([]);
});

it("add --plan previews the new dependency without touching files", async () => {
  await install();
  const lockBefore = await lockText();
  const manifestBefore = await manifestText();
  const result = await runDependencyCommand({
    command: "add",
    args: ["--plan", "gamma@1.0.0"],
    projectDir: project,
    store,
    registry,
  });
  expect(result.readiness).toBe("plan");
  expect(result.plan!.direct.added).toEqual([
    { name: "gamma", to: "^1.0.0", group: "dependencies" },
  ]);
  expect(result.plan!.packages.added).toEqual([{ name: "gamma", to: "1.0.0" }]);
  expect(await lockText()).toBe(lockBefore);
  expect(await manifestText()).toBe(manifestBefore);
});
