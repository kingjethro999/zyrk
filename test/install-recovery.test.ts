import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { recoverProjection } from "../src/project/projection.ts";
import { rmrfNoFollow, pathExists } from "../src/util/fsx.ts";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-recovery-"));
  await mkdir(path.join(root, ".zyrk-local"));
});
afterEach(async () => {
  await rmrfNoFollow(root);
});
const generationId = "gen1_abcdef234";
async function journal(metadataOnly = false, done = false) {
  const events = [
    {
      event: "staged",
      generationId,
      metadataOnly,
      files: [
        { name: "package-lock.json", before: "old-lock", after: "new-lock" },
      ],
    },
    ...(done ? [{ event: "done", generationId }] : []),
  ];
  await writeFile(
    path.join(root, ".zyrk-local/journal.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
}
it("restores old metadata and links after interruption before publishing the new projection", async () => {
  const old = path.join(root, `node_modules.zyrk-old-${generationId}`);
  await mkdir(old);
  await writeFile(path.join(old, "old.txt"), "old");
  await writeFile(path.join(root, "package-lock.json"), "new-lock");
  await journal();
  await recoverProjection(root);
  expect(await readFile(path.join(root, "package-lock.json"), "utf8")).toBe(
    "old-lock",
  );
  expect(await readFile(path.join(root, "node_modules/old.txt"), "utf8")).toBe(
    "old",
  );
});
it("finishes new metadata when the new projection was already published", async () => {
  await mkdir(path.join(root, "node_modules/.zyrk"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules/.zyrk/install-state.json"),
    JSON.stringify({ generationId }),
  );
  await journal();
  await recoverProjection(root);
  expect(await readFile(path.join(root, "package-lock.json"), "utf8")).toBe(
    "new-lock",
  );
});
it("recovers metadata-only updates without disturbing the old projection", async () => {
  for (const done of [false, true]) {
    await journal(true, done);
    await recoverProjection(root);
    expect(await readFile(path.join(root, "package-lock.json"), "utf8")).toBe(
      done ? "new-lock" : "old-lock",
    );
    expect(await pathExists(path.join(root, "node_modules"))).toBe(false);
  }
});
it("rejects journal traversal before removing any filesystem entries", async () => {
  await writeFile(
    path.join(root, ".zyrk-local/journal.jsonl"),
    JSON.stringify({ event: "staged", generationId: "../../outside" }),
  );
  await expect(recoverProjection(root)).rejects.toMatchObject({
    code: "ZYRK_STORE_CORRUPT",
  });
});
