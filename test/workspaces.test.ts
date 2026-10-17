import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  discoverWorkspaces,
  planWorkspaceDependencies,
  selectWorkspaceImporters,
  assertNoLiveSourceBuilds,
  workspaceScriptOrder,
} from "../src/install/workspaces.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
let root: string;
async function manifest(id: string, value: Record<string, unknown>) {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify(value));
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-workspaces-"));
});
afterEach(async () => {
  await rmrfNoFollow(root);
});
it("discovers standard patterns in deterministic importer order with one root", async () => {
  await manifest(".", {
    name: "root",
    workspaces: { packages: ["packages/*", "!packages/excluded"] },
  });
  await manifest("packages/b", { name: "@test/b", version: "1.0.0" });
  await manifest("packages/a", { name: "a", version: "1.0.0" });
  await manifest("packages/excluded", { name: "excluded", version: "1.0.0" });
  await manifest("node_modules/hidden", { name: "hidden", version: "1.0.0" });
  const project = await discoverWorkspaces(root);
  expect(project.importers.map((item) => item.id)).toEqual([
    ".",
    "packages/a",
    "packages/b",
  ]);
  expect(project.importers[1]?.source.kind).toBe("live-directory");
  expect(project.importers[1]?.source.projectContext).toBe(
    project.importers[2]?.source.projectContext,
  );
  expect(
    selectWorkspaceImporters(project, ["@test/b", "./packages/a"]).map(
      (item) => item.id,
    ),
  ).toEqual(["packages/a", "packages/b"]);
  expect(() => selectWorkspaceImporters(project, ["test"])).toThrow();
});
it("fingerprints every importer's requirements and membership", async () => {
  await manifest(".", { workspaces: ["packages/*"] });
  await manifest("packages/a", {
    name: "a",
    version: "1.0.0",
    dependencies: { external: "^1" },
  });
  const first = await discoverWorkspaces(root);
  await manifest("packages/a", {
    name: "a",
    version: "1.0.0",
    dependencies: { external: "^2" },
  });
  expect((await discoverWorkspaces(root)).manifestFingerprint).not.toBe(
    first.manifestFingerprint,
  );
});
it("rejects duplicate names, linked package roots and escaped patterns", async () => {
  await manifest(".", { workspaces: ["packages/*"] });
  await manifest("packages/a", { name: "same", version: "1.0.0" });
  await manifest("packages/b", { name: "same", version: "1.0.0" });
  await expect(discoverWorkspaces(root)).rejects.toMatchObject({
    code: "ZYRK_MANIFEST_INVALID",
  });
  await manifest("packages/b", { name: "different", version: "1.0.0" });
  await symlink(
    path.join(root, "packages/a"),
    path.join(root, "packages/link"),
  );
  await expect(discoverWorkspaces(root)).rejects.toMatchObject({
    code: "ZYRK_MANIFEST_INVALID",
  });
  await manifest(".", { workspaces: ["../outside/*"] });
  await expect(discoverWorkspaces(root)).rejects.toMatchObject({
    code: "ZYRK_MANIFEST_INVALID",
  });
});
it("bounds traversal and rejects per-importer security configuration", async () => {
  await manifest(".", { workspaces: ["packages/*"] });
  await manifest("packages/a", {
    name: "a",
    version: "1.0.0",
    zyrk: { scripts: { default: "allow-all" } },
  });
  await expect(discoverWorkspaces(root)).rejects.toMatchObject({
    code: "ZYRK_MANIFEST_INVALID",
  });
  await manifest("packages/a", { name: "a", version: "1.0.0" });
  await expect(
    discoverWorkspaces(root, { maxDirectories: 1 }),
  ).rejects.toMatchObject({ code: "ZYRK_MANIFEST_INVALID" });
});
it("plans local edges without inventing immutable source identities or installing", async () => {
  await manifest(".", {
    workspaces: ["packages/*"],
    dependencies: { a: "workspace:*" },
  });
  await manifest("packages/a", {
    name: "a",
    version: "1.2.0",
    dependencies: { b: "^1", external: "^3" },
    peerDependencies: { b: "workspace:^" },
    peerDependenciesMeta: { b: { optional: true } },
  });
  await manifest("packages/b", {
    name: "b",
    version: "1.3.0",
    dependencies: { a: "file:../a" },
  });
  const plan = planWorkspaceDependencies(await discoverWorkspaces(root));
  expect(plan[0]?.dependencies[0]?.selection).toEqual({
    kind: "local",
    importer: "packages/a",
  });
  expect(
    plan[1]?.dependencies.find((edge) => edge.name === "external")?.selection
      .kind,
  ).toBe("registry");
  expect(
    plan[1]?.dependencies.find((edge) => edge.kind === "peer"),
  ).toMatchObject({
    peerOptional: true,
    selection: { kind: "local", importer: "packages/b" },
  });
  expect(() => workspaceScriptOrder(plan)).toThrow();
  expect(plan[2]?.dependencies[0]?.selection).toEqual({
    kind: "local",
    importer: "packages/a",
  });
});
it("requires explicit workspace ranges to match and rejects unknown local directories", async () => {
  await manifest(".", {
    workspaces: ["packages/*"],
    dependencies: { a: "workspace:^2" },
  });
  await manifest("packages/a", { name: "a", version: "1.0.0" });
  const project = await discoverWorkspaces(root);
  expect(() => planWorkspaceDependencies(project)).toThrow();
  await manifest(".", {
    workspaces: ["packages/*"],
    dependencies: { missing: "file:./missing" },
  });
  const missing = await discoverWorkspaces(root);
  expect(() => planWorkspaceDependencies(missing)).toThrow();
});
it("rejects candidate builds reaching live source through peers or cycles", () => {
  const edges = new Map<string, string[]>([
    ["plugin", ["host"]],
    ["host", ["plugin", "local"]],
    ["safe", []],
  ]);
  const liveSources = new Map([["local", "packages/app"]]);
  expect(() =>
    assertNoLiveSourceBuilds({
      builds: [{ key: "plugin", name: "plugin" }],
      edges,
      liveSources,
    }),
  ).toThrow(
    expect.objectContaining({
      code: "ZYRK_WORKSPACE_BUILD_CONTEXT_UNSUPPORTED",
    }),
  );
  expect(() =>
    assertNoLiveSourceBuilds({
      builds: [{ key: "safe", name: "safe" }],
      edges,
      liveSources,
    }),
  ).not.toThrow();
});

it("orders acyclic workspace scripts dependency-first and rejects unresolved build closures", async () => {
  await manifest(".", {
    workspaces: ["packages/*"],
    dependencies: { a: "workspace:*" },
  });
  await manifest("packages/a", {
    name: "a",
    version: "1.0.0",
    dependencies: { b: "workspace:*" },
  });
  await manifest("packages/b", { name: "b", version: "1.0.0" });
  expect(
    workspaceScriptOrder(
      planWorkspaceDependencies(await discoverWorkspaces(root)),
    ),
  ).toEqual(["packages/b", "packages/a", "."]);
  expect(() =>
    assertNoLiveSourceBuilds({
      builds: [{ key: "unknown", name: "unknown" }],
      edges: new Map(),
      liveSources: new Map(),
    }),
  ).toThrow();
});
