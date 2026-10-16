import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractTarball,
  type ExtractionResult,
} from "../src/extract/tarball.ts";
import { getObject, getSource, openStoreDb } from "../src/store/db.ts";
import { Store } from "../src/store/layout.ts";
import {
  readSourceManifest,
  sourceManifestPath,
} from "../src/store/manifests.ts";
import { objectPathFor } from "../src/store/objects.ts";
import {
  commitExtractedSource,
  type CommitSourceInput,
} from "../src/store/source.ts";
import { manifestHashOf, sourceIdOf } from "../src/util/hash.ts";
import { craftTar, type CraftEntry } from "./helpers/tar.ts";

const ORIGIN = "https://registry.npmjs.org";
const INTEGRITY = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

let root: string;
let store: Store;
let counter = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nexu-source-"));
  store = await Store.open({ root, create: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function extract(entries: CraftEntry[]): Promise<ExtractionResult> {
  counter += 1;
  const staging = path.join(root, "staging");
  const tarballPath = path.join(staging, `archive-${counter}.tgz`);
  await mkdir(staging, { recursive: true });
  await writeFile(tarballPath, craftTar(entries));
  return extractTarball({
    tarballPath,
    destDir: path.join(staging, `extract-${counter}`),
  });
}

function commitInput(
  extraction: ExtractionResult,
  overrides: Partial<CommitSourceInput> = {},
): CommitSourceInput {
  return {
    store,
    extraction,
    name: "demo-pkg",
    version: "1.0.0",
    origin: ORIGIN,
    integrity: INTEGRITY,
    archiveBytes: 1024,
    ...overrides,
  };
}

async function objectCount(): Promise<number> {
  const sha512Dir = path.join(store.paths.objectsDir, "sha512");
  let total = 0;
  for (const prefix of await readdir(sha512Dir)) {
    total += (await readdir(path.join(sha512Dir, prefix))).length;
  }
  return total;
}

describe("commitExtractedSource", () => {
  it("commits files to the CAS, writes a canonical manifest, and indexes metadata", async () => {
    // Deliberately out of canonical order in the archive.
    const extraction = await extract([
      { path: "package/z-last.txt", data: "z\n" },
      { path: "package/cli.js", data: "#!/usr/bin/env node\n", mode: 0o755 },
      { path: "package", type: "dir" },
      { path: "package/link.js", type: "symlink", link: "index.js" },
      { path: "package/index.js", data: "module.exports = 1;\n" },
    ]);
    const db = openStoreDb(store.paths.dbFile);
    try {
      const result = await commitExtractedSource(
        commitInput(extraction, { db }),
      );

      expect(result.created).toBe(true);
      expect(result.sourceId).toBe(
        sourceIdOf({
          sourceType: "registry",
          name: "demo-pkg",
          version: "1.0.0",
          origin: ORIGIN,
          integrity: INTEGRITY,
        }),
      );

      const doc = await readSourceManifest(store, result.sourceId);
      expect(doc.manifestHash).toBe(manifestHashOf(doc.manifest));
      expect(doc.manifest.sourceId).toBe(result.sourceId);
      expect(doc.manifest.origin).toBe(ORIGIN);
      expect(doc.manifest.totals).toEqual(extraction.totals);

      const paths = doc.manifest.entries.map((entry) => entry.path);
      expect(paths).toEqual([...paths].sort());

      const byPath = new Map(
        doc.manifest.entries.map((entry) => [entry.path, entry]),
      );
      const cli = byPath.get("cli.js");
      if (cli?.type !== "file")
        throw new Error("expected cli.js as a file entry");
      expect(
        (await stat(objectPathFor(store, cli.objectId))).mode & 0o777,
      ).toBe(0o555);

      const index = byPath.get("index.js");
      if (index?.type !== "file")
        throw new Error("expected index.js as a file entry");
      expect(
        (await stat(objectPathFor(store, index.objectId))).mode & 0o777,
      ).toBe(0o444);

      const link = byPath.get("link.js");
      if (link?.type !== "symlink")
        throw new Error("expected link.js as a symlink entry");
      expect(link.target).toBe("index.js");

      const source = getSource(db, result.sourceId);
      expect(source?.manifestHash).toBe(doc.manifestHash);
      const cliObject = getObject(db, cli.objectId);
      expect(cliObject).toMatchObject({
        modeClass: "exec",
        innerDigest: cli.innerDigest,
        bytes: cli.size,
      });
    } finally {
      db.close();
    }
  });

  it("shares one object for identical bytes at different paths", async () => {
    const extraction = await extract([
      { path: "package/a.txt", data: "identical bytes\n" },
      { path: "package/b.txt", data: "identical bytes\n" },
    ]);
    const result = await commitExtractedSource(commitInput(extraction));
    const doc = await readSourceManifest(store, result.sourceId);

    const a = doc.manifest.entries.find((entry) => entry.path === "a.txt");
    const b = doc.manifest.entries.find((entry) => entry.path === "b.txt");
    if (a?.type !== "file" || b?.type !== "file")
      throw new Error("expected two file entries");
    expect(a.objectId).toBe(b.objectId);
    expect(await objectCount()).toBe(1);
  });

  it("reuses an identical source instead of re-committing it", async () => {
    const extraction = await extract([
      { path: "package/index.js", data: "x\n" },
    ]);
    const first = await commitExtractedSource(commitInput(extraction));
    const second = await commitExtractedSource(commitInput(extraction));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.manifestHash).toBe(first.manifestHash);
    await expect(
      readSourceManifest(store, first.sourceId),
    ).resolves.toMatchObject({
      manifestHash: first.manifestHash,
    });
  });

  it("treats a different verified archive as a different source identity", async () => {
    const extraction = await extract([
      { path: "package/index.js", data: "x\n" },
    ]);
    const otherIntegrity =
      "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
    const a = await commitExtractedSource(
      commitInput(extraction, { integrity: INTEGRITY }),
    );
    const b = await commitExtractedSource(
      commitInput(extraction, { integrity: otherIntegrity }),
    );

    expect(a.sourceId).not.toBe(b.sourceId);
    expect(b.created).toBe(true);
    await expect(readSourceManifest(store, a.sourceId)).resolves.toBeDefined();
    await expect(readSourceManifest(store, b.sourceId)).resolves.toBeDefined();
    // Bytes still dedupe across identities (SPEC 8.1); only the identity differs.
    expect(await objectCount()).toBe(1);
  });

  it("refuses to commit an empty extraction", async () => {
    const empty: ExtractionResult = {
      entries: [],
      totals: { files: 0, dirs: 0, symlinks: 0, logicalBytes: 0 },
      outcomes: [],
      commonRoot: null,
      observations: [],
    };
    await expect(
      commitExtractedSource(commitInput(empty)),
    ).rejects.toMatchObject({
      code: "NEXU_EXTRACTION_UNSAFE",
    });
  });

  it("refuses ambiguous duplicate entry paths", async () => {
    const duplicate: ExtractionResult = {
      entries: [
        { path: "dup", type: "dir" },
        { path: "dup", type: "dir" },
      ],
      totals: { files: 0, dirs: 2, symlinks: 0, logicalBytes: 0 },
      outcomes: [],
      commonRoot: null,
      observations: [],
    };
    await expect(
      commitExtractedSource(commitInput(duplicate)),
    ).rejects.toMatchObject({
      code: "NEXU_EXTRACTION_UNSAFE",
    });
  });
});

describe("readSourceManifest integrity", () => {
  it("rejects a manifest whose recorded hash no longer matches its content", async () => {
    const extraction = await extract([
      { path: "package/index.js", data: "x\n" },
    ]);
    const result = await commitExtractedSource(commitInput(extraction));
    const manifestPath = sourceManifestPath(store, result.sourceId);

    await chmod(manifestPath, 0o644);
    const doc = JSON.parse(await readFile(manifestPath, "utf8")) as {
      manifest: { version: string };
    };
    doc.manifest.version = "9.9.9";
    await writeFile(manifestPath, JSON.stringify(doc));

    await expect(
      readSourceManifest(store, result.sourceId),
    ).rejects.toMatchObject({
      code: "NEXU_STORE_CORRUPT",
    });
  });

  it("rejects a manifest that is not valid JSON", async () => {
    const extraction = await extract([
      { path: "package/index.js", data: "x\n" },
    ]);
    const result = await commitExtractedSource(commitInput(extraction));
    const manifestPath = sourceManifestPath(store, result.sourceId);

    await chmod(manifestPath, 0o644);
    await writeFile(manifestPath, "{ not json");

    await expect(
      readSourceManifest(store, result.sourceId),
    ).rejects.toMatchObject({
      code: "NEXU_STORE_CORRUPT",
    });
  });

  it("reports a missing manifest as store corruption, not a silent miss", async () => {
    await expect(
      readSourceManifest(store, "src-missing-source"),
    ).rejects.toMatchObject({
      code: "NEXU_STORE_CORRUPT",
    });
  });
});
