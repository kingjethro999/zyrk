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
  return {
    sourceId: `src1_${overrides.key.replace(/[^A-Za-z0-9]/g, "")}`,
    integrity: `sha512-${Buffer.from(overrides.key).toString("base64")}`,
    origin: "https://registry.example.com",
    tarballUrl: `https://registry.example.com/${overrides.name}/-/${overrides.name}-${overrides.version}.tgz`,
    bin: {},
    edges: [],
    peerBindings: [],
    platform: {},
    ...overrides,
  };
}

const FINGERPRINTS = {
  manifest: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  scripts: "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
  config: "sha512-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=",
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
        "node_modules/app": { version: "0.9.0", license: "MIT", extra: true },
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

    expect(doc.packages?.["node_modules/transitive"]).toEqual({
      version: "1.2.3",
      resolved: "https://example.com/t.tgz",
    });
    expect(doc.packages?.[""]).toMatchObject({ license: "MIT" });
    expect(doc.packages?.["node_modules/app"]).toMatchObject({
      version: "1.0.0",
      license: "MIT",
      extra: true,
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
