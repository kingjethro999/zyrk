import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { docsIndex, searchDocs } from "../web/lib/docs-index.ts";

it("indexes every published documentation section and resolves every local target", async () => {
  const page = await readFile(
    new URL("../web/app/docs/page.tsx", import.meta.url),
    "utf8",
  );
  const ids = [...page.matchAll(/<section id="([^"]+)"/g)].map(
    (match) => match[1],
  );
  expect(docsIndex.map((entry) => entry.id)).toEqual(ids);
  expect(new Set(ids).size).toBe(ids.length);
});
it("searches commands, errors and trust vocabulary without interpreting markup", () => {
  expect(searchDocs("postinstall").map((entry) => entry.id)).toEqual([
    "script-trust",
  ]);
  expect(
    searchDocs("  ZYRK_OFFLINE_MISSING ").map((entry) => entry.id),
  ).toEqual(["troubleshooting"]);
  expect(searchDocs("Next.js Windows").map((entry) => entry.id)).toEqual([
    "compatibility",
  ]);
  expect(searchDocs("<script>alert(1)</script>")).toEqual([]);
  expect(searchDocs("")).toHaveLength(docsIndex.length);
  expect(searchDocs("xyz".repeat(100000))).toEqual([]);
});
