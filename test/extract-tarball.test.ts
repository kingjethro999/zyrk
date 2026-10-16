import { mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnpmError } from "../src/errors.ts";
import { DEFAULT_EXTRACTION_LIMITS, extractTarball, normalizeArchivePath } from "../src/extract/tarball.ts";
import { craftTar, craftTarGz, type CraftEntry } from "./helpers/tar.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "snpm-extract-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeArchive(bytes: Buffer, name = "archive.tgz"): Promise<string> {
  const file = path.join(workDir, name);
  await writeFile(file, bytes);
  return file;
}

async function extract(entries: CraftEntry[], options: { gzip?: boolean; limits?: Record<string, number> } = {}) {
  const bytes = options.gzip === true ? craftTarGz(entries) : craftTar(entries);
  const tarballPath = await writeArchive(bytes);
  const destDir = path.join(workDir, `dest-${Math.random().toString(36).slice(2)}`);
  const result = await extractTarball({
    tarballPath,
    destDir,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { result, destDir, tarballPath };
}

async function expectUnsafe(run: () => Promise<unknown>, messagePart?: string): Promise<SnpmError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SnpmError);
    const snpmError = error as SnpmError;
    expect(snpmError.code).toBe("SNPM_EXTRACTION_UNSAFE");
    if (messagePart !== undefined) {
      expect(snpmError.message).toContain(messagePart);
    }
    return snpmError;
  }
  throw new Error("expected extraction to fail, but it succeeded");
}

describe("extractTarball: happy path", () => {
  it("extracts a normal package and strips the common root", async () => {
    const pkgJson = '{"name":"demo"}';
    const libJs = "module.exports = 1;\n";
    const cliJs = "#!/usr/bin/env node\n";
    const { result, destDir } = await extract([
      { path: "package/", type: "dir" },
      { path: "package/package.json", data: pkgJson },
      { path: "package/lib/", type: "dir" },
      { path: "package/lib/index.js", data: libJs },
      { path: "package/bin/cli.js", data: cliJs, mode: 0o755 },
      { path: "package/readme-link", type: "symlink", link: "lib/index.js" },
    ]);

    expect(result.commonRoot).toBe("package");
    // The stripped wrapper counts neither as file nor as dir; `bin/` exists
    // only implicitly and is not a planned directory entry.
    expect(result.totals).toEqual({
      files: 3,
      dirs: 1,
      symlinks: 1,
      logicalBytes: Buffer.byteLength(pkgJson) + Buffer.byteLength(libJs) + Buffer.byteLength(cliJs),
    });
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "bin/cli.js",
      "lib",
      "lib/index.js",
      "package.json",
      "readme-link",
    ]);
    expect(result.outcomes).toContain("common-root-stripped:package");
    expect(result.outcomes).toContain("symlinks-present");
    expect(result.outcomes).toContain("traversal-checked");
    expect(result.outcomes).toContain("absolute-paths-rejected");

    const indexEntry = result.entries.find((entry) => entry.path === "lib/index.js");
    expect(indexEntry?.type).toBe("file");
    if (indexEntry?.type === "file") {
      expect(indexEntry.mode).toBe("plain");
      await expect(readFile(indexEntry.stagingPath, "utf8")).resolves.toBe(libJs);
    }
    const cliEntry = result.entries.find((entry) => entry.path === "bin/cli.js");
    expect(cliEntry?.type).toBe("file");
    if (cliEntry?.type === "file") {
      expect(cliEntry.mode).toBe("exec");
      expect((await stat(cliEntry.stagingPath)).mode & 0o777).toBe(0o755);
    }
    const linkEntry = result.entries.find((entry) => entry.path === "readme-link");
    expect(linkEntry?.type).toBe("symlink");
    if (linkEntry?.type === "symlink") {
      expect(linkEntry.target).toBe("lib/index.js");
      await expect(readlink(path.join(destDir, "readme-link"))).resolves.toBe("lib/index.js");
    }
  });

  it("keeps paths when there is no single wrapping root", async () => {
    const { result } = await extract([
      { path: "package.json", data: "{}" },
      { path: "lib/index.js", data: "x" },
    ]);
    expect(result.commonRoot).toBeNull();
    expect(result.entries.map((entry) => entry.path)).toEqual(["lib/index.js", "package.json"]);
  });

  it("normalizes redundant separators and dot segments", async () => {
    const { result } = await extract([{ path: "package//./lib//index.js", data: "x" }]);
    expect(result.commonRoot).toBe("package");
    expect(result.entries.map((entry) => entry.path)).toEqual(["lib/index.js"]);
  });

  it("handles gzip-compressed archives", async () => {
    const { result } = await extract([{ path: "package/a.txt", data: "hello" }], { gzip: true });
    expect(result.totals.files).toBe(1);
    const entry = result.entries[0];
    if (entry?.type === "file") {
      await expect(readFile(entry.stagingPath, "utf8")).resolves.toBe("hello");
    }
  });

  it("materializes hard links to already-extracted files", async () => {
    const { result } = await extract([
      { path: "package/original.txt", data: "shared bytes" },
      { path: "package/copy.txt", type: "hardlink", link: "package/original.txt" },
    ]);
    const original = result.entries.find((entry) => entry.path === "original.txt");
    const copy = result.entries.find((entry) => entry.path === "copy.txt");
    expect(original?.type).toBe("file");
    expect(copy?.type).toBe("file");
    if (original?.type === "file" && copy?.type === "file") {
      expect(copy.innerDigest).toBe(original.innerDigest);
      expect(copy.mode).toBe(original.mode);
      await expect(readFile(copy.stagingPath, "utf8")).resolves.toBe("shared bytes");
    }
    expect(result.outcomes).toContain("hardlinks-present");
  });

  it("records Windows-reserved names as observations, not fatal errors on POSIX", async () => {
    const { result } = await extract([{ path: "package/con.txt", data: "reserved!" }]);
    expect(result.totals.files).toBe(1);
    expect(result.observations.join("\n")).toContain("reserved on Windows");
    expect(result.outcomes).toContain("reserved-windows-names:1");
  });

  it("detects dangling and cyclic symlinks without failing the extraction", async () => {
    const { result } = await extract([
      { path: "package/a", type: "symlink", link: "b" },
      { path: "package/b", type: "symlink", link: "a" },
      { path: "package/dangling", type: "symlink", link: "missing.txt" },
    ]);
    expect(result.outcomes).toContain("cyclic-symlinks:2");
    expect(result.outcomes).toContain("internal-dangling-symlinks:1");
  });
});

describe("extractTarball: path safety", () => {
  it("rejects upward traversal", async () => {
    await expectUnsafe(() => extract([{ path: "package/../../evil.txt", data: "x" }]), "traverses upwards");
  });

  it("rejects absolute paths", async () => {
    await expectUnsafe(() => extract([{ path: "/etc/passwd", data: "x" }]), "absolute");
  });

  it("rejects backslash paths", async () => {
    await expectUnsafe(() => extract([{ path: "package\\evil", data: "x" }]), "backslash");
  });

  it("rejects Windows drive letters", async () => {
    await expectUnsafe(() => extract([{ path: "C:/evil.txt", data: "x" }]), "drive letter");
  });

  it("rejects duplicate paths", async () => {
    await expectUnsafe(
      () =>
        extract([
          { path: "package/a.txt", data: "one" },
          { path: "package/a.txt", data: "two" },
        ]),
      "more than once",
    );
  });

  it("rejects case-folding collisions", async () => {
    await expectUnsafe(
      () =>
        extract([
          { path: "package/README.md", data: "a" },
          { path: "package/readme.md", data: "b" },
        ]),
      "case-folding collision",
    );
  });
});

describe("extractTarball: symlink and hard link safety", () => {
  it("rejects absolute symlink targets", async () => {
    await expectUnsafe(() => extract([{ path: "package/link", type: "symlink", link: "/etc/passwd" }]), "absolute");
  });

  it("rejects symlink targets that escape the package root", async () => {
    await expectUnsafe(
      () => extract([{ path: "package/dir/link", type: "symlink", link: "../../outside" }]),
      "escapes the package root",
    );
  });

  it("rejects symlink targets containing backslashes", async () => {
    await expectUnsafe(
      () => extract([{ path: "package/link", type: "symlink", link: "..\\..\\evil" }]),
      "backslash",
    );
  });

  it("refuses to write a file through a symlinked directory", async () => {
    await expectUnsafe(
      () =>
        extract([
          { path: "package/real/", type: "dir" },
          { path: "package/linkdir", type: "symlink", link: "real" },
          { path: "package/linkdir/file.txt", data: "x" },
        ]),
      "write through a symlink",
    );
  });

  it("rejects hard links whose target leaves the archive", async () => {
    await expectUnsafe(
      () =>
        extract([
          { path: "package/a.txt", data: "x" },
          { path: "package/link", type: "hardlink", link: "../../elsewhere" },
        ]),
      "traverses upwards",
    );
  });

  it("rejects hard links to paths that are not extracted regular files", async () => {
    await expectUnsafe(
      () =>
        extract([
          { path: "package/dir/", type: "dir" },
          { path: "package/link", type: "hardlink", link: "package/dir" },
        ]),
      "not an extracted regular file",
    );
    await expectUnsafe(
      () =>
        extract([
          { path: "package/a.txt", data: "x" },
          { path: "package/link", type: "hardlink", link: "package/missing.txt" },
        ]),
      "not an extracted regular file",
    );
  });
});

describe("extractTarball: limits and malformed archives", () => {
  it("enforces the entry-count bound", async () => {
    const entries: CraftEntry[] = [];
    for (let i = 0; i < 5; i += 1) entries.push({ path: `package/f${i}.txt`, data: "x" });
    await expectUnsafe(() => extract(entries, { limits: { maxEntries: 3 } }), "more than 3 entries");
  });

  it("enforces the expanded-bytes bound", async () => {
    const entries: CraftEntry[] = [
      { path: "package/a.txt", data: Buffer.alloc(600, 0x61) },
      { path: "package/b.txt", data: Buffer.alloc(600, 0x62) },
    ];
    await expectUnsafe(() => extract(entries, { limits: { maxTotalBytes: 1000 } }), "expands to more than");
  });

  it("enforces component and total path length bounds", () => {
    // ustar cannot even encode a >255-byte component, so the bound is
    // exercised directly; GNU/PAX long-name entries feed the same function.
    expect(() => normalizeArchivePath(`a/${"n".repeat(300)}.txt`, DEFAULT_EXTRACTION_LIMITS)).toThrow(
      /component longer than 255/,
    );
    const longPath = Array.from({ length: 40 }, (_, index) => `segment-${index}-xxxxxxxxxx`).join("/");
    expect(() =>
      normalizeArchivePath(longPath, { ...DEFAULT_EXTRACTION_LIMITS, maxPathLength: 64 }),
    ).toThrow(/path longer than 64/);
  });

  it("wraps malformed archive bytes as SNPM_EXTRACTION_UNSAFE", async () => {
    const tarballPath = await writeArchive(Buffer.alloc(2048, 0x41));
    await expectUnsafe(() => extractTarball({ tarballPath, destDir: path.join(workDir, "dest") }));
  });

  it("rejects a truncated data payload", async () => {
    const full = craftTar([{ path: "package/a.txt", data: Buffer.alloc(2000, 0x7a) }]);
    const truncated = full.subarray(0, 512 + 100 + 512);
    const tarballPath = await writeArchive(truncated);
    await expectUnsafe(() => extractTarball({ tarballPath, destDir: path.join(workDir, "dest") }));
  });
});

describe("normalizeArchivePath", () => {
  it("flags reserved and Windows-invalid names without failing", () => {
    const reserved = normalizeArchivePath("con.txt", DEFAULT_EXTRACTION_LIMITS);
    expect(reserved.reserved).toBe(true);
    expect(reserved.invalidWindows).toBe(false);

    const invalid = normalizeArchivePath("foo:bar.txt", DEFAULT_EXTRACTION_LIMITS);
    expect(invalid.invalidWindows).toBe(true);
    expect(invalid.reserved).toBe(false);

    const plain = normalizeArchivePath("lib/index.js", DEFAULT_EXTRACTION_LIMITS);
    expect(plain).toEqual({ normalized: "lib/index.js", reserved: false, invalidWindows: false });
  });

  it("normalizes redundant separators and dots", () => {
    expect(normalizeArchivePath("a//b/./c", DEFAULT_EXTRACTION_LIMITS).normalized).toBe("a/b/c");
  });

  it("rejects empty paths", () => {
    expect(() => normalizeArchivePath("", DEFAULT_EXTRACTION_LIMITS)).toThrow(SnpmError);
    expect(() => normalizeArchivePath("./", DEFAULT_EXTRACTION_LIMITS)).toThrow(SnpmError);
  });
});
