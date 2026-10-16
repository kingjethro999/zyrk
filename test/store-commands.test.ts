import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStoreCommand } from "../src/commands/store.ts";
import { extractTarball } from "../src/extract/tarball.ts";
import { openStoreDb } from "../src/store/db.ts";
import { createGraphDoc, graphHash } from "../src/store/graph.ts";
import { Store } from "../src/store/layout.ts";
import { readSourceManifest } from "../src/store/manifests.ts";
import { objectPathFor } from "../src/store/objects.ts";
import { commitExtractedSource } from "../src/store/source.ts";
import { craftTar } from "./helpers/tar.ts";

let directory: string;
let store: Store;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "zyrk-store-commands-"));
  store = await Store.open({
    root: path.join(directory, "store"),
    create: true,
  });
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
const run = (...args: string[]) =>
  runStoreCommand({ command: "store", args, store, cwd: directory });
const projects = (...args: string[]) =>
  runStoreCommand({ command: "projects", args, store, cwd: directory });

async function source() {
  const archive = path.join(directory, "fixture.tgz");
  await fs.writeFile(
    archive,
    craftTar([{ path: "package/index.js", data: "module.exports = 42;" }]),
  );
  const extraction = await extractTarball({
    tarballPath: archive,
    destDir: path.join(directory, "extracted"),
  });
  const result = await commitExtractedSource({
    store,
    extraction,
    name: "fixture",
    version: "1.0.0",
    origin: "https://registry.npmjs.org",
    integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    archiveBytes: 1024,
  });
  const graph = createGraphDoc([
    { name: "fixture", version: "1.0.0", sourceId: result.sourceId },
  ]);
  const digest = graphHash(graph);
  await fs.writeFile(
    path.join(store.paths.graphsDir, `${digest}.json`),
    JSON.stringify(graph),
  );
  return { sourceId: result.sourceId, digest };
}
async function root(kind: "pin" | "generation" = "generation") {
  const fixture = await source();
  await fs.writeFile(
    path.join(store.paths.pinsDir, "retention.json"),
    JSON.stringify({
      kind,
      projectId: "project1_fixture",
      project: path.join(directory, "missing-project"),
      graph: fixture.digest,
      instances: [],
      sources: [fixture.sourceId],
    }),
  );
  return fixture;
}
async function ageGrace() {
  const file = path.join(store.paths.metadataDir, "gc-unreferenced.json");
  const marks = JSON.parse(await fs.readFile(file, "utf8")) as Record<
    string,
    number
  >;
  for (const key of Object.keys(marks))
    marks[key] = Date.now() - 31 * 86400_000;
  await fs.writeFile(file, JSON.stringify(marks));
}

describe("store commands", () => {
  it("reports the canonical path and labels allocation as an estimate", async () => {
    expect(await run("path")).toEqual({ path: store.root });
    expect(await run("status")).toMatchObject({
      initialized: true,
      graceDays: 30,
      allocationMethod: expect.stringContaining("Estimate"),
    });
  });
  it("verifies source payloads and fails on corruption", async () => {
    const fixture = await source();
    expect(await run("verify", "--full")).toMatchObject({
      verified: true,
      sources: 1,
      objects: 1,
    });
    const manifest = await readSourceManifest(store, fixture.sourceId);
    const entry = manifest.manifest.entries.find(
      (entry) => entry.type === "file",
    );
    if (!entry || entry.type !== "file")
      throw new Error("missing fixture payload");
    const object = objectPathFor(store, entry.objectId);
    await fs.chmod(object, 0o600);
    await fs.writeFile(object, "tampered");
    await expect(run("verify", "--full")).rejects.toMatchObject({
      code: "ZYRK_STORE_CORRUPT",
    });
  });
  it("keeps missing projects protected until explicitly forgotten", async () => {
    await root();
    expect(await projects("list")).toMatchObject({
      projects: [
        {
          projectId: "project1_fixture",
          reachability: expect.stringContaining("retained"),
        },
      ],
    });
    expect(await run("gc")).toMatchObject({ removed: 0 });
    expect(await projects("forget", "project1_fixture")).toMatchObject({
      removedRoots: 1,
      impact: expect.stringContaining("may break"),
    });
    expect(await projects("list")).toEqual({ projects: [] });
  });
  it("keeps explicit pins independent of project registrations", async () => {
    await root("pin");
    expect(await projects("list")).toEqual({ projects: [] });
    expect(await run("gc")).toMatchObject({ removed: 0 });
    expect(await run("unpin", "retention")).toMatchObject({
      unpinned: "retention",
    });
  });
  it("makes dry run read-only and collects only after observed grace", async () => {
    const fixture = await source();
    expect(await run("gc", "--dry-run")).toMatchObject({
      candidates: [],
      removed: 0,
    });
    await expect(
      fs.stat(path.join(store.paths.metadataDir, "gc-unreferenced.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await run("gc")).toMatchObject({ removed: 0 });
    await ageGrace();
    expect(await run("gc", "--dry-run")).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({ kind: "object" }),
      ]),
      removed: 0,
    });
    await fs.stat(path.join(store.paths.sourcesDir, fixture.sourceId));
    expect(await run("gc")).toMatchObject({
      removed: 3,
      physicalBytesReclaimed: "unavailable",
    });
    await expect(
      fs.stat(path.join(store.paths.sourcesDir, fixture.sourceId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retains old objects reused by a recently observed graph", async () => {
    const fixture = await source();
    await run("gc");
    await ageGrace();
    const file = path.join(store.paths.metadataDir, "gc-unreferenced.json");
    const marks = JSON.parse(await fs.readFile(file, "utf8")) as Record<
      string,
      number
    >;
    delete marks[path.join("graphs", `${fixture.digest}.json`)];
    await fs.writeFile(file, JSON.stringify(marks));
    expect(await run("gc")).toMatchObject({ removed: 0 });
  });
  it("fails closed for staged work and active or uncertain leases", async () => {
    await source();
    await run("gc");
    await ageGrace();
    await fs.mkdir(path.join(store.paths.stagingDir, "pending"));
    expect(await run("gc")).toMatchObject({
      removed: 0,
      retentionReasons: [expect.stringContaining("Staging")],
    });
    await fs.rmdir(path.join(store.paths.stagingDir, "pending"));
    const db = openStoreDb(store.paths.dbFile);
    db.prepare("INSERT INTO leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "lease1_test",
      process.pid,
      null,
      "fixture",
      "{}",
      "uncertain",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();
    expect(await run("gc")).toMatchObject({
      removed: 0,
      retentionReasons: [expect.stringContaining("leases")],
    });
  });
  it("rejects symlinked inventory directories without touching their targets", async () => {
    const outside = path.join(directory, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep"), "keep");
    await fs.symlink(outside, path.join(store.paths.sourcesDir, "unsafe"));
    await expect(run("gc")).rejects.toMatchObject({
      code: "ZYRK_STORE_CORRUPT",
    });
    expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("keep");
  });
  it("rejects corrupt root paths and unpin traversal", async () => {
    await fs.writeFile(
      path.join(store.paths.pinsDir, "bad.json"),
      JSON.stringify({
        kind: "pin",
        graph: "okay",
        instances: [directory],
        sources: [],
      }),
    );
    await expect(run("gc")).rejects.toMatchObject({
      code: "ZYRK_STORE_CORRUPT",
    });
    await expect(run("unpin", "../../bad")).rejects.toMatchObject({
      code: "ZYRK_STORE_CORRUPT",
    });
  });
});
