import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readLockfile, validateLockDoc } from "../src/lockfile/read.ts";
import { importNpmLock } from "../src/install/import-npm.ts";
import { cleanUrl } from "../src/install/lock.ts";
import { parseRequirement } from "../src/resolve/spec.ts";
import type { NpmLockDoc } from "../src/lockfile/types.ts";

const registry = "https://registry.npmjs.org";
const sponsor = "https://github.com/prettier/prettier?sponsor=1";
async function trackedLock(): Promise<NpmLockDoc> {
  return JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
}
function onePackage(engines: unknown): NpmLockDoc {
  return {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { jsonparse: "1.3.1" } },
      "node_modules/jsonparse": {
        version: "1.3.1",
        resolved: `${registry}/jsonparse/-/jsonparse-1.3.1.tgz`,
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        engines,
      },
    },
  };
}

describe("npm self-install metadata", () => {
  it("reads the tracked repository lock including GitHub funding query URLs", async () => {
    const result = await readLockfile(
      new URL("../package-lock.json", import.meta.url).pathname,
    );
    expect(
      result?.doc.packages?.["node_modules/prettier"]?.funding,
    ).toBeDefined();
  });
  it("imports the tracked repository exact selections without registry resolution", async () => {
    const doc = await trackedLock();
    const root = doc.packages![""]!;
    const requirements = {
      ...(root.dependencies as Record<string, string>),
      ...(root.devDependencies as Record<string, string>),
    };
    const graph = importNpmLock(doc, requirements, registry);
    expect(
      graph.nodes.find((node) => node.name === "jsonparse")?.engines,
    ).toEqual({ node: ">= 0.2.0" });
    expect(graph.roots.map((root) => root.name).sort()).toEqual(
      Object.keys(requirements).sort(),
    );
  });
  it.each([
    { funding: sponsor },
    { funding: { type: "github", url: sponsor } },
    { funding: [sponsor, { type: "github", url: sponsor }] },
  ])("accepts only funding value forms: %j", ({ funding }) => {
    expect(() =>
      validateLockDoc(
        { lockfileVersion: 3, packages: { "": { funding } } },
        "fixture",
      ),
    ).not.toThrow();
    expect(cleanUrl(sponsor)).toBe(false);
  });
  it.each(["resolved", "homepage", "url", "arbitrary"])(
    "rejects the same URL outside funding (%s)",
    (field) => {
      expect(() =>
        validateLockDoc({ packages: { "": { [field]: sponsor } } }, "fixture"),
      ).toThrow(/unsafe URL/);
    },
  );
  it.each([
    sponsor + "&token=secret",
    sponsor + "#secret",
    "https://user@github.com/prettier/prettier?sponsor=1",
    "http://github.com/prettier/prettier?sponsor=1",
    sponsor.replace("sponsor=1", "sponsor=2"),
    "https://github.com/prettier/prettier?sponsor=1&other=1",
    "https://github.com/prettier/prettier?%73ponsor=1",
  ])("rejects unsafe funding URL %s", (url) => {
    expect(() =>
      validateLockDoc({ packages: { "": { funding: [{ url }] } } }, "fixture"),
    ).toThrow(/unsafe URL/);
  });
  it("accepts the tracked Vite sponsorship URL and rejects nested url containers", () => {
    expect(() =>
      validateLockDoc(
        {
          packages: {
            "": {
              funding: { url: "https://github.com/vitejs/vite?sponsor=1" },
            },
          },
        },
        "fixture",
      ),
    ).not.toThrow();
    expect(() =>
      validateLockDoc(
        { packages: { "": { funding: { url: { url: sponsor } } } } },
        "fixture",
      ),
    ).toThrow(/unsafe URL/);
  });
  it("does not extend the exception through arbitrary funding fields", () => {
    expect(() =>
      validateLockDoc(
        { packages: { "": { funding: { homepage: sponsor } } } },
        "fixture",
      ),
    ).toThrow(/unsafe URL/);
  });
  it("normalizes legacy engine arrays and retains modern engine maps", () => {
    expect(
      importNpmLock(
        onePackage(["node >= 0.2.0", "npm >=1"]),
        { jsonparse: "1.3.1" },
        registry,
      ).nodes[0]?.engines,
    ).toEqual({ node: ">= 0.2.0", npm: ">=1" });
    expect(
      importNpmLock(
        onePackage({ node: ">= 0.2.0" }),
        { jsonparse: "1.3.1" },
        registry,
      ).nodes[0]?.engines,
    ).toEqual({ node: ">= 0.2.0" });
  });
  it.each(
    [
      ["node"],
      ["node nonsense"],
      [42],
      ["node >=1", "node >=2"],
      { node: 12 },
      null,
    ].map((engines) => ({ engines })),
  )("rejects malformed engine constraints %j", ({ engines }) => {
    expect(() =>
      importNpmLock(onePackage(engines), { jsonparse: "1.3.1" }, registry),
    ).toThrow(/invalid npm engine constraint/);
  });
  it.each(["=0.154.0", "v0.154.0", "=v0.154.0"])(
    "normalizes npm exact version %s",
    (spec) => {
      expect(parseRequirement("esbuild", spec).targetSpec).toBe("0.154.0");
    },
  );
  it.each(["1.2.3+build.2", "=v1.2.3+build.2"])(
    "retains exact build metadata in %s",
    (spec) => {
      expect(parseRequirement("pkg", spec).targetSpec).toBe("1.2.3+build.2");
    },
  );
});
