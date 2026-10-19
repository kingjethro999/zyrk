import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { adaptNextDisplay } from "../src/dlx/next-display.ts";

const header =
  "console.log(`Creating a new Next.js app in ${(0,Pe.green)(T)}.`);console.log();process.chdir(T);";
const label =
  'console.log((0,Pe.bold)(`Using ${i}.`));console.log("\\nInitializing project with template:",a,"\\n");';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-next-display-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each([header, header + label + label, header + header + label])(
  "rejects an unverified or ambiguous display contract without editing it",
  async (original) => {
    const file = path.join(root, "initializer.js");
    await writeFile(file, original);
    await expect(adaptNextDisplay(file, "16.4.2", false)).rejects.toMatchObject(
      { code: "ZYRK_RESOLUTION_FAILED" },
    );
    expect(await readFile(file, "utf8")).toBe(original);
  },
);

it("refuses to edit an initializer script sharing a source inode", async () => {
  const original = header + label;
  const source = path.join(root, "source.js"),
    file = path.join(root, "initializer.js");
  await writeFile(source, original);
  await link(source, file);
  await expect(adaptNextDisplay(file, "16.4.2", false)).rejects.toMatchObject({
    code: "ZYRK_INTERNAL",
  });
  expect(await readFile(source, "utf8")).toBe(original);
});
