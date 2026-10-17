import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { craftTarGz } from "./helpers/tar.ts";
import { installProject } from "../src/install/run.ts";
import { Store } from "../src/store/layout.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import {
  canonicalStrongSri,
  isCanonicalStrongSri,
  assertIntegrityOk,
  IntegrityHasher,
  parseSri,
} from "../src/util/integrity.ts";
import { readLockfile } from "../src/lockfile/read.ts";
import { lockedGraph } from "../src/install/lock.ts";
import { rmrfNoFollow, pathExists } from "../src/util/fsx.ts";
let root: string,
  project: string,
  store: Store,
  server: Server,
  registry: RegistryClient,
  origin: string,
  integrity: string;
const archive = craftTarGz([
  {
    path: "package/package.json",
    data: JSON.stringify({ name: "fixture", version: "1.0.0" }),
  },
  { path: "package/index.js", data: 'module.exports="verified";' },
]);
const sri = (algorithm: string, bytes = archive) =>
  `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-sri-install-"));
  project = path.join(root, "project");
  await mkdir(project);
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ dependencies: { fixture: "1.0.0" } }),
  );
  store = await Store.open({ root: path.join(root, "store"), create: true });
  server = createServer((request, response) => {
    if (request.url === "/archive.tgz") {
      response.end(archive);
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name: "fixture",
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "fixture",
            version: "1.0.0",
            dist: { tarball: `${origin}/archive.tgz`, integrity },
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  origin = `http://127.0.0.1:${address.port}`;
  registry = new RegistryClient({ registry: origin, userAgent: "test" });
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) =>
      error &&
      (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
        ? reject(error)
        : resolve(),
    ),
  );
  await rmrfNoFollow(root);
});
const cases = [
  sri("sha256"),
  sri("sha384"),
  `${sri("sha256")} ${sri("sha512")}`,
  `${sri("sha384", Buffer.from("wrong"))} ${sri("sha256")} ${sri("sha384")}`,
];
it.each(cases)(
  "installs and freezes the canonical strong expected set %s",
  async (expected) => {
    integrity = expected;
    const first = await installProject({
      projectDir: project,
      store,
      registry,
    });
    expect(first.readiness).toBe("ready");
    const lock = (await readLockfile(path.join(project, "package-lock.json")))!
      .doc;
    expect(lockedGraph(lock).nodes[0]?.integrity).toBe(
      canonicalStrongSri(expected),
    );
    expect(lock.packages?.["node_modules/fixture"]?.integrity).toBe(
      canonicalStrongSri(expected),
    );
    const manifestFiles = await readdir(store.paths.sourcesDir);
    expect(manifestFiles.length).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(
      (
        await installProject({
          projectDir: project,
          store,
          registry,
          frozen: true,
          offline: true,
        })
      ).readiness,
    ).toBe("ready");
    expect(
      await readFile(
        path.join(project, "node_modules/fixture/index.js"),
        "utf8",
      ),
    ).toContain("verified");
  },
);
it.each([sri("sha256"), sri("sha384"), `${sri("sha256")} ${sri("sha512")}`])(
  "imports npm strong integrity without changing its allowed digest set %s",
  async (expected) => {
    integrity = expected;
    await writeFile(
      path.join(project, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { fixture: "1.0.0" } },
          "node_modules/fixture": {
            version: "1.0.0",
            resolved: `${origin}/archive.tgz`,
            integrity,
          },
        },
      }),
    );
    await installProject({
      projectDir: project,
      store,
      registry,
      importNpm: true,
    });
    expect(
      lockedGraph(
        (await readLockfile(path.join(project, "package-lock.json")))!.doc,
      ).nodes[0]?.integrity,
    ).toBe(canonicalStrongSri(expected));
    expect(
      (
        await installProject({
          projectDir: project,
          store,
          registry,
          frozen: true,
          offline: true,
        })
      ).readiness,
    ).toBe("ready");
  },
);
it("does not accept a weaker digest when stronger expected metadata mismatches", async () => {
  integrity = `${sri("sha256")} ${sri("sha512", Buffer.from("wrong"))}`;
  await expect(
    installProject({ projectDir: project, store, registry }),
  ).rejects.toMatchObject({ code: "ZYRK_INTEGRITY_FAILED" });
  expect(await pathExists(path.join(project, "node_modules"))).toBe(false);
  expect(await pathExists(path.join(project, "package-lock.json"))).toBe(false);
});
it("normalizes strongest alternatives while rejecting malformed sizes, weak-only and noncanonical locks", () => {
  const expected = `${sri("sha384")} ${sri("sha256")} ${sri("sha384", Buffer.from("wrong"))} ${sri("sha384")}`;
  const canonical = canonicalStrongSri(expected)!;
  expect(canonical.split(" ")).toHaveLength(2);
  expect(canonicalStrongSri(expected.split(" ").reverse().join(" "))).toBe(
    canonical,
  );
  const hasher = new IntegrityHasher();
  hasher.update(archive);
  expect(
    assertIntegrityOk(hasher.finalize(), expected, { what: "fixture" })
      .verifiedSri,
  ).toBe(canonical);
  for (const malformed of [
    "sha256-YQ==",
    "sha384-YQ==",
    "sha512-YQ==",
    sri("sha1"),
    `${sri("sha512")} invalid`,
  ])
    expect(canonicalStrongSri(malformed)).toBeUndefined();
  expect(parseSri(`sha256-${"A".repeat(42)}B=`).valid).toBe(false);
  expect(isCanonicalStrongSri(`${canonical} ${sri("sha256")}`)).toBe(false);
});

it.each([sri("sha1"), "sha256-YQ=="])(
  "rejects weak or malformed registry integrity before publication %s",
  async (expected) => {
    integrity = expected;
    await expect(
      installProject({ projectDir: project, store, registry }),
    ).rejects.toMatchObject({ code: "ZYRK_INTEGRITY_FAILED" });
    expect(await pathExists(path.join(project, "node_modules"))).toBe(false);
  },
);
