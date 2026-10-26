import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { lockedGraph } from "../src/install/lock.ts";
import { sourceIdOf } from "../src/util/hash.ts";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configFingerprint,
  manifestFingerprint,
  scriptPolicyFingerprint,
} from "../src/lockfile/fingerprints.ts";
import { assertFrozenCompatible, readLockfile } from "../src/lockfile/read.ts";
import type { NpmLockDoc } from "../src/lockfile/types.ts";
import { writeLockfile } from "../src/lockfile/write.ts";
import type { ResolvedOccurrence } from "../src/resolve/resolver.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "zyrk-lock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function node(
  overrides: Partial<ResolvedOccurrence> & {
    key: string;
    name: string;
    version: string;
  },
): ResolvedOccurrence {
  const result: ResolvedOccurrence = {
    sourceId: `src1_${overrides.key.replace(/[^A-Za-z0-9]/g, "")}`,
    integrity: `sha512-${createHash("sha512").update(overrides.key).digest("base64")}`,
    origin: "https://registry.example.com",
    tarballUrl: `https://registry.example.com/${overrides.name}/-/${overrides.name}-${overrides.version}.tgz`,
    bin: {},
    edges: [],
    peerBindings: [],
    platform: {},
    ...overrides,
  };
  result.sourceId = sourceIdOf({
    sourceType: "registry",
    name: result.name,
    version: result.version,
    origin: result.origin,
    integrity: result.integrity,
  });
  return result;
}

const FINGERPRINTS = {
  manifest: manifestFingerprint({}),
  scripts: scriptPolicyFingerprint(undefined),
  config: configFingerprint({
    registry: "https://registry.example.com",
    linker: "shared",
  }),
};

function appResolution() {
  const app = node({
    key: "app@1.0.0",
    name: "app",
    version: "1.0.0",
    edges: [{ name: "lib", target: "lib@2.0.0", kind: "prod", spec: "^2.0.0" }],
  });
  const lib = node({ key: "lib@2.0.0", name: "lib", version: "2.0.0" });
  return {
    nodes: [app, lib],
    roots: [{ name: "app", target: "app@1.0.0" }],
  };
}

describe("writeLockfile", () => {
  it("writes selections, direct entries, and the full zyrk extension", async () => {
    const lockPath = path.join(dir, "package-lock.json");
    const doc = await writeLockfile({
      path: lockPath,
      name: "demo",
      version: "0.0.0",
      manifestDeps: { app: "^1.0.0" },
      resolution: appResolution(),
      fingerprints: FINGERPRINTS,
    });

    expect(doc.lockfileVersion).toBe(3);
    expect(doc.packages?.[""] ?? {}).toMatchObject({
      name: "demo",
      dependencies: { app: "^1.0.0" },
    });
    expect(doc.packages?.["node_modules/app"]).toMatchObject({
      version: "1.0.0",
      resolved: "https://registry.example.com/app/-/app-1.0.0.tgz",
      integrity: doc.packages?.["node_modules/app"]?.["integrity"],
    });
    expect(doc.zyrk?.resolver).toBe("zyrk-resolve/1");
    expect(doc.zyrk?.manifest).toBe(FINGERPRINTS.manifest);
    expect(doc.zyrk?.nodes["app@1.0.0"]).toMatchObject({
      name: "app",
      version: "1.0.0",
      edges: { lib: "lib@2.0.0" },
      edgeKinds: { lib: "prod" },
      peers: {},
    });
    expect(doc.zyrk?.roots).toEqual({ ".": { app: "app@1.0.0" } });

    const onDisk = JSON.parse(await readFile(lockPath, "utf8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(doc)));

    const secondPath = path.join(dir, "second-lock.json");
    await writeLockfile({
      path: secondPath,
      name: "demo",
      version: "0.0.0",
      manifestDeps: { app: "^1.0.0" },
      resolution: appResolution(),
      fingerprints: FINGERPRINTS,
    });
    expect(await readFile(secondPath, "utf8")).toBe(
      await readFile(lockPath, "utf8"),
    );
  });

  it("preserves npm-owned data it does not own", async () => {
    const existing: NpmLockDoc = {
      name: "demo",
      version: "0.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "demo", version: "0.0.0", license: "MIT" },
        "node_modules/app": {
          version: "0.9.0",
          license: "MIT",
          funding: { url: "https://github.com/example/app?sponsor=1" },
          extra: true,
        },
        "node_modules/transitive": {
          version: "1.2.3",
          resolved: "https://example.com/t.tgz",
        },
      },
      customField: 42,
    };
    const doc = await writeLockfile({
      path: path.join(dir, "package-lock.json"),
      name: "demo",
      version: "0.0.0",
      manifestDeps: { app: "^1.0.0" },
      existing,
      resolution: appResolution(),
      fingerprints: FINGERPRINTS,
    });

    expect(doc.packages?.["node_modules/transitive"]).toBeUndefined();
    expect(doc.packages?.[""]).toMatchObject({ license: "MIT" });
    expect(doc.packages?.["node_modules/app"]).toMatchObject({
      version: "1.0.0",
      license: "MIT",
      funding: { url: "https://github.com/example/app?sponsor=1" },
    });
    expect(doc.customField).toBe(42);
    expect(doc.zyrk).toBeDefined();
  });

  it("keeps the extension purely additive for npm readers", async () => {
    const lockPath = path.join(dir, "package-lock.json");
    const doc = await writeLockfile({
      path: lockPath,
      name: "demo",
      version: "0.0.0",
      manifestDeps: { app: "^1.0.0" },
      resolution: appResolution(),
      fingerprints: FINGERPRINTS,
    });
    // npm's loader reads only the keys it knows and carries the rest
    // through untouched (verified against the pinned npm's
    // @npmcli/arborist shrinkwrap.js load(), which spreads unknown
    // top-level fields into its data object). The extension must therefore
    // be confined to its single top-level key, and npm package entries
    // must contain no zyrk namespaced keys.
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(new Set(Object.keys(raw))).toEqual(
      new Set([
        "name",
        "version",
        "lockfileVersion",
        "requires",
        "packages",
        "zyrk",
      ]),
    );
    for (const entry of Object.values(
      raw["packages"] as Record<string, unknown>,
    )) {
      for (const key of Object.keys(entry as Record<string, unknown>)) {
        expect(key.startsWith("zyrk")).toBe(false);
      }
    }
    const { zyrk: _removed, ...npmView } = raw;
    expect(npmView["packages"]).toBeDefined();
  });
});

describe("readLockfile", () => {
  it("returns null for a missing lockfile", async () => {
    expect(await readLockfile(path.join(dir, "package-lock.json"))).toBeNull();
  });

  it("round-trips a written lockfile", async () => {
    const lockPath = path.join(dir, "package-lock.json");
    const written = await writeLockfile({
      path: lockPath,
      name: "demo",
      version: "0.0.0",
      manifestDeps: { app: "^1.0.0" },
      resolution: appResolution(),
      fingerprints: FINGERPRINTS,
    });
    const read = await readLockfile(lockPath);
    expect(read?.doc).toEqual(written);
  });

  it("rejects malformed lockfiles", async () => {
    const lockPath = path.join(dir, "package-lock.json");
    await writeFile(lockPath, "{not json");
    await expect(readLockfile(lockPath)).rejects.toMatchObject({
      code: "ZYRK_MANIFEST_INVALID",
    });
    await writeFile(
      lockPath,
      JSON.stringify({ lockfileVersion: 1, packages: {} }),
    );
    await expect(readLockfile(lockPath)).rejects.toMatchObject({
      code: "ZYRK_MANIFEST_INVALID",
    });
  });

  it("rejects extensions from unsupported writers", async () => {
    const lockPath = path.join(dir, "package-lock.json");
    const doc = await writeLockfile({
      path: lockPath,
      name: "demo",
      version: "0.0.0",
      manifestDeps: { app: "^1.0.0" },
      resolution: appResolution(),
      fingerprints: FINGERPRINTS,
    });
    if (doc.zyrk !== undefined) doc.zyrk.version = 999;
    await writeFile(lockPath, JSON.stringify(doc));
    await expect(readLockfile(lockPath)).rejects.toMatchObject({
      code: "ZYRK_LOCK_MISMATCH",
    });
  });
});

describe("assertFrozenCompatible", () => {
  it("accepts matching fingerprints", async () => {
    const doc = await writeLockfile({
      path: path.join(dir, "package-lock.json"),
      name: "demo",
      version: "0.0.0",
      manifestDeps: { app: "^1.0.0" },
      resolution: appResolution(),
      fingerprints: FINGERPRINTS,
    });
    expect(() => assertFrozenCompatible(doc, FINGERPRINTS)).not.toThrow();
  });

  it("fails each drifted fingerprint with ZYRK_LOCK_MISMATCH", async () => {
    const doc = await writeLockfile({
      path: path.join(dir, "package-lock.json"),
      name: "demo",
      version: "0.0.0",
      manifestDeps: { app: "^1.0.0" },
      resolution: appResolution(),
      fingerprints: FINGERPRINTS,
    });
    for (const field of ["manifest", "scripts", "config"] as const) {
      const tampered = {
        ...FINGERPRINTS,
        [field]: "sha512-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX=",
      };
      try {
        assertFrozenCompatible(doc, tampered);
        expect.unreachable(`expected a ${field} mismatch`);
      } catch (error) {
        expect(error).toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
      }
    }
    try {
      assertFrozenCompatible(doc, { ...FINGERPRINTS, manifest: "sha512-x" });
      expect.unreachable("expected a mismatch");
    } catch (error) {
      expect(String((error as Error).message)).toContain(
        "manifest fingerprint differs",
      );
    }
  });

  it("fails lockfiles without an extension", async () => {
    const plain: NpmLockDoc = {
      name: "demo",
      version: "0.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "demo" } },
    };
    try {
      assertFrozenCompatible(plain, FINGERPRINTS);
      expect.unreachable("expected a missing-extension mismatch");
    } catch (error) {
      expect(error).toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
    }
  });
});

describe("fingerprints", () => {
  it("are deterministic and order-independent", () => {
    const first = manifestFingerprint({
      dependencies: { b: "^1.0.0", a: "~2.0.0" },
    });
    const second = manifestFingerprint({
      dependencies: { a: "~2.0.0", b: "^1.0.0" },
    });
    expect(first).toBe(second);
    expect(first.startsWith("sha512-")).toBe(true);
  });

  it("change when requirements or policy change", () => {
    const base = manifestFingerprint({ dependencies: { a: "^1.0.0" } });
    expect(manifestFingerprint({ dependencies: { a: "^2.0.0" } })).not.toBe(
      base,
    );
    expect(scriptPolicyFingerprint(undefined)).toBe(
      scriptPolicyFingerprint({ default: "deny", allow: [], deny: [] }),
    );
    expect(scriptPolicyFingerprint({ default: "allow-all" })).not.toBe(
      scriptPolicyFingerprint(undefined),
    );
    expect(
      configFingerprint({ registry: "https://a.example", linker: "shared" }),
    ).not.toBe(
      configFingerprint({ registry: "https://b.example", linker: "shared" }),
    );
  });
});

it("fingerprints peer optionality independently of key order", () => {
  const declaration = { peerDependencies: { host: "*" } };
  expect(
    manifestFingerprint({
      ...declaration,
      peerDependenciesMeta: { host: { optional: true } },
    }),
  ).not.toBe(manifestFingerprint(declaration));
});

it("rejects malformed graphs through every public lock consumer", async () => {
  const original = await writeLockfile({
    path: path.join(dir, "lock.json"),
    name: "demo",
    version: "1.0.0",
    manifestDeps: { app: "*" },
    resolution: appResolution(),
    fingerprints: FINGERPRINTS,
  });
  const mutations: Array<(value: Record<string, any>) => void> = [
    (value) => {
      value.zyrk.nodes = [];
    },
    (value) => {
      value.zyrk.roots = [];
    },
    (value) => {
      value.zyrk.resolver = "future";
    },
    (value) => {
      value.zyrk.contextCanonicalization = 999;
    },
    (value) => {
      value.zyrk.manifest = {};
    },
    (value) => {
      value.zyrk.nodes["app@1.0.0"].edges.lib = "missing";
    },
    (value) => {
      value.zyrk.nodes["app@1.0.0"].edgeKinds.lib = "unknown";
    },
    (value) => {
      value.zyrk.nodes["app@1.0.0"].peers.host = "lib@2.0.0";
    },
    (value) => {
      value.zyrk.nodes["app@1.0.0"].bin = { demo: "../outside" };
    },
    (value) => {
      value.zyrk.nodes["app@1.0.0"].platform.os = {};
    },
    (value) => {
      value.zyrk.nodes["app@1.0.0"].optionalPeers = null;
    },
    (value) => {
      value.zyrk.nodes["app@1.0.0"].source = "forged";
    },
    (value) => {
      value.zyrk.nodes["app@1.0.0"].tarball += "?token=secret";
    },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(original);
    mutate(bad);
    await writeFile(path.join(dir, "bad-lock.json"), JSON.stringify(bad));
    await expect(
      readLockfile(path.join(dir, "bad-lock.json")),
    ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
    expect(() => assertFrozenCompatible(bad, FINGERPRINTS)).toThrow();
    expect(() => lockedGraph(bad)).toThrow();
  }
});

it("rejects secret-bearing new and preserved metadata before writing", async () => {
  for (const existing of [
    { custom: { token: "secret" } },
    { custom: { _authToken: "secret" } },
    { custom: "https://user:secret@example.test/archive" },
    { custom: "https://example.test/archive?signature=secret" },
    { custom: "/home/user/private" },
  ]) {
    await expect(
      writeLockfile({
        path: path.join(dir, "unsafe.json"),
        name: "demo",
        version: "1.0.0",
        manifestDeps: {},
        resolution: appResolution(),
        fingerprints: FINGERPRINTS,
        existing,
      }),
    ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
    await expect(readFile(path.join(dir, "unsafe.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  }
});

it("matches pinned npm Arborist's resolved graph for aliases, cycles, peers and optional edges", async () => {
  expect(require("@npmcli/arborist/package.json").version).toBe("10.0.3");
  const Arborist = require("@npmcli/arborist");
  const resolution = appResolution();
  const app = resolution.nodes[0]!;
  const lib = resolution.nodes[1]!;
  const host = node({ key: "host@1.0.0", name: "host", version: "1.0.0" });
  const optional = node({ key: "opt@1.0.0", name: "opt", version: "1.0.0" });
  app.edges.push(
    { name: "host", target: host.key, kind: "peer", spec: "*" },
    { name: "opt", target: optional.key, kind: "optional", spec: "*" },
  );
  app.peerBindings.push(
    { name: "host", target: host.key, optional: true },
    { name: "absent", target: null },
  );
  lib.edges.push({
    name: "alias",
    target: app.key,
    kind: "prod",
    spec: "npm:app@1.0.0",
  });
  resolution.nodes.push(host, optional);
  resolution.roots = [
    { name: "alias", target: app.key },
    { name: "host", target: host.key },
  ];
  const deps = { alias: "npm:app@1.0.0", host: "1.0.0" };
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", dependencies: deps }),
  );
  const doc = await writeLockfile({
    path: path.join(dir, "package-lock.json"),
    name: "demo",
    version: "1.0.0",
    manifestDeps: deps,
    resolution,
    fingerprints: FINGERPRINTS,
    existing: {
      packages: { "node_modules/removed": { version: "9.9.9" } },
      dependencies: { removed: { version: "9.9.9" } },
    },
  });
  const tree = await new Arborist({
    path: dir,
    offline: true,
    ignoreScripts: true,
  }).loadVirtual();
  expect(tree.inventory.size).toBe(Object.keys(doc.packages!).length);
  expect(tree.inventory.query("name", "removed").size).toBe(0);
  const visited = new Set<string>();
  const compare = (key: string, actual: any): void => {
    const expected = resolution.nodes.find((value) => value.key === key)!;
    expect(actual.package.name).toBe(expected.name);
    expect(actual.package.version).toBe(expected.version);
    if (visited.has(`${key}:${actual.location}`)) return;
    visited.add(`${key}:${actual.location}`);
    for (const edge of expected.edges) {
      const npmEdge = actual.edgesOut.get(edge.name);
      expect(npmEdge?.valid, `${actual.location}:${edge.name}`).toBe(true);
      expect(npmEdge.type).toBe(
        expected.peerBindings.some(
          (peer) => peer.name === edge.name && peer.optional,
        )
          ? "peerOptional"
          : edge.kind,
      );
      compare(edge.target, npmEdge.to);
    }
    for (const peer of expected.peerBindings)
      if (peer.target === null) {
        const npmEdge = actual.edgesOut.get(peer.name);
        expect(npmEdge.type).toBe("peerOptional");
        expect(npmEdge.to).toBeNull();
      }
  };
  for (const root of resolution.roots)
    compare(root.target, tree.edgesOut.get(root.name).to);
});

it("places parent peers beside their consumer even when a child requested the same peer first", async () => {
  const app = node({ key: "app@1.0.0", name: "app", version: "1.0.0" });
  const child = node({ key: "child@1.0.0", name: "child", version: "1.0.0" });
  const host = node({ key: "host@1.0.0", name: "host", version: "1.0.0" });
  app.edges = [
    { name: "child", target: child.key, kind: "prod", spec: "1.0.0" },
    { name: "host", target: host.key, kind: "peer", spec: "1.0.0" },
  ];
  child.edges = [
    { name: "host", target: host.key, kind: "peer", spec: "1.0.0" },
  ];
  app.peerBindings = [{ name: "host", target: host.key }];
  child.peerBindings = [{ name: "host", target: host.key, optional: true }];
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: { app: "1.0.0" },
    }),
  );
  const doc = await writeLockfile({
    path: path.join(dir, "package-lock.json"),
    name: "demo",
    version: "1.0.0",
    manifestDeps: { app: "1.0.0" },
    fingerprints: FINGERPRINTS,
    resolution: {
      nodes: [app, child, host],
      roots: [{ name: "app", target: app.key }],
    },
  });
  const Arborist = require("@npmcli/arborist");
  const tree = await new Arborist({
    path: dir,
    offline: true,
    ignoreScripts: true,
  }).loadVirtual();
  for (const actual of tree.inventory.values())
    for (const edge of actual.edgesOut.values())
      expect(edge.valid, `${actual.location}:${edge.name}:${edge.error}`).toBe(
        true,
      );
  expect(doc.packages?.["node_modules/host"]?.version).toBe("1.0.0");
  expect(doc.packages?.["node_modules/app/node_modules/host"]).toBeUndefined();
});
