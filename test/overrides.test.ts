import { expect, it } from "vitest";
import { createRootOverrides } from "../src/resolve/overrides.ts";
it("inherits nested version-qualified overrides through intermediate packages", () => {
  const policy = createRootOverrides({
    dependencies: { parent: "1" },
    overrides: { "parent@1": { child: "2.0.0" } },
  });
  const parent = policy.select(policy.root, "parent", "1.0.0");
  const middle = policy.select(parent.context, "middle", "1.0.0");
  expect(policy.select(middle.context, "child", "^1").spec).toBe("2.0.0");
  expect(policy.select(policy.root, "child", "^1").spec).toBe("^1");
});
it("allows self replacements, references and registry alias forks", () => {
  const policy = createRootOverrides({
    dependencies: { host: "^2" },
    overrides: {
      child: "$host",
      parent: { ".": "2.0.0", leaf: "npm:fork@1.0.0" },
      host: "$host",
    },
  });
  expect(policy.select(policy.root, "child", "^1").spec).toBe("^2");
  const parent = policy.select(policy.root, "parent", "^1");
  expect(parent.spec).toBe("2.0.0");
  expect(policy.select(parent.context, "leaf", "*").spec).toBe(
    "npm:fork@1.0.0",
  );
});
it.each([
  null,
  [],
  "1.0.0",
  { child: false },
  { child: null },
  { child: { ".": {} } },
  { child: "$missing" },
  { ".": "1.0.0" },
  { "child@latest": "1.0.0" },
  { child: "https://user:secret@example.com/a.tgz" },
])(
  "rejects malformed or unsupported policy without leaking its input",
  (overrides) => {
    expect(() => createRootOverrides({ overrides })).toThrow(/override/i);
  },
);
it("rejects direct override specs differing even when semver-compatible", () => {
  expect(() =>
    createRootOverrides({
      dependencies: { child: "^1" },
      overrides: { child: "1.0.0" },
    }),
  ).toThrow(/direct/i);
});
it("adopts overridden exact npm selections and rejects locks that contradict the root policy", async () => {
  const { importNpmLock } = await import("../src/install/import-npm.ts");
  const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64"),
    origin = "https://registry.example.com/";
  const policy = createRootOverrides({
    dependencies: { parent: "1.0.0" },
    overrides: { parent: { child: "2.0.0" } },
  });
  const doc = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { parent: "1.0.0" } },
      "node_modules/parent": {
        version: "1.0.0",
        integrity,
        resolved: origin + "parent.tgz",
        dependencies: { child: "1.0.0" },
      },
      "node_modules/child": {
        version: "2.0.0",
        integrity,
        resolved: origin + "child.tgz",
      },
    },
  };
  expect(
    importNpmLock(doc, { parent: "1.0.0" }, origin, policy).nodes.find(
      (n) => n.name === "child",
    )!.version,
  ).toBe("2.0.0");
  doc.packages["node_modules/child"].version = "1.0.0";
  expect(() => importNpmLock(doc, { parent: "1.0.0" }, origin, policy)).toThrow(
    /requirement/,
  );
});
it("matches pinned Arborist's nested inherited registry edge rules", async () => {
  const { createRequire } = await import("node:module"),
    path = await import("node:path"),
    require = createRequire(import.meta.url);
  expect(require("@npmcli/arborist/package.json").version).toBe("10.0.3");
  const OverrideSet = require(
    path.join(
      path.dirname(require.resolve("@npmcli/arborist/package.json")),
      "lib/override-set.js",
    ),
  );
  const raw = { "parent@1.0.0": { child: "2.0.0" }, child: "3.0.0" };
  const policy = createRootOverrides({ overrides: raw });
  let expected = new OverrideSet({ overrides: structuredClone(raw) }),
    actual = policy.root;
  for (const [name, spec] of [
    ["parent", "1.0.0"],
    ["middle", "1.0.0"],
    ["child", "^1"],
  ] as const) {
    expected = expected.getEdgeRule({ name, rawSpec: spec });
    const selected = policy.select(actual, name, spec);
    actual = selected.context;
    expect(selected.spec).toBe(
      expected.value && expected.value !== "*" ? expected.value : spec,
    );
  }
  expect(policy.select(policy.root, "parent", "2.0.0").context).toBe(
    policy.root,
  );
});
it("enforces the direct override rule for version-qualified local importer selectors", () => {
  expect(() =>
    createRootOverrides({
      dependencies: { member: "file:packages/member" },
      overrides: { "member@1": { ".": "2.0.0" } },
    }),
  ).toThrow(/direct/i);
});
it("matches Arborist direct-edge legality when reference lookup and dependency groups differ", async () => {
  const { createRequire } = await import("node:module"),
    require = createRequire(import.meta.url),
    Arborist = require("@npmcli/arborist");
  const manifest = {
    name: "app",
    version: "1.0.0",
    dependencies: { host: "^1" },
    devDependencies: { host: "^2" },
    overrides: { host: "$host" },
  };
  const root = new Arborist.Node({
    path: "/unused",
    pkg: structuredClone(manifest),
    loadOverrides: true,
  });
  // Pinned Node loads dev last. Model zyrk's selected production edge
  // explicitly to compare the legality check against its actual root edge.
  expect(root.edgesOut.get("host").rawSpec).toBe("^2");
  expect(() => root.assertRootOverrides()).not.toThrow();
  new Arborist.Edge({ from: root, name: "host", spec: "^1", type: "prod" });
  expect(root.edgesOut.get("host").rawSpec).toBe("^1");
  expect(root.edgesOut.get("host").spec).toBe("^2");
  expect(() => root.assertRootOverrides()).toThrow(
    /conflicts with direct dependency/,
  );
  expect(() => createRootOverrides(manifest)).toThrow(/direct/);
});
it("preserves nested override rule order while dependency declaration order stays canonical", async () => {
  const { manifestFingerprint } =
    await import("../src/lockfile/fingerprints.ts");
  expect(
    manifestFingerprint({
      overrides: { parent: { leaf: "1.0.0", "leaf@^1": "2.0.0" } },
    }),
  ).not.toBe(
    manifestFingerprint({
      overrides: { parent: { "leaf@^1": "2.0.0", leaf: "1.0.0" } },
    }),
  );
  expect(manifestFingerprint({ dependencies: { a: "1", b: "2" } })).toBe(
    manifestFingerprint({ dependencies: { b: "2", a: "1" } }),
  );
});
