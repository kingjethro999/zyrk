import { expect, it } from "vitest";
import { createInstallProgress } from "../src/cli/progress.ts";

it("renders plain progress without escapes and remains quiet for JSON", () => {
  const chunks: string[] = [];
  const stream = { write: (s: string) => chunks.push(s) };
  const ui = createInstallProgress(stream, false);
  ui.update({ phase: "resolving" });
  ui.update({ phase: "fetching", completed: 1, total: 2 });
  ui.close();
  expect(chunks.join("")).toContain("Preparing installation");
  expect(chunks.join("")).toContain("1/2");
  expect(chunks.join("")).not.toContain("\u001b");
  const before = chunks.join("");
  const quiet = createInstallProgress(stream, true);
  quiet.update({ phase: "resolving" });
  quiet.close();
  expect(chunks.join("")).toBe(before);
});

it("renders the staged install display and success footer in a TTY", () => {
  const chunks: string[] = [];
  const ui = createInstallProgress(
    { isTTY: true, write: (s) => chunks.push(s) },
    false,
    { color: false },
  );
  ui.update({ phase: "planning" });
  ui.update({ phase: "resolving" });
  ui.update({
    phase: "fetching",
    completed: 2,
    total: 3,
    reused: 1,
    downloaded: 1,
  });
  ui.update({ phase: "realizing" });
  ui.update({ phase: "linking" });
  ui.close({
    title: "Installed from the verified shared store.",
    detail: "Your project still uses node_modules and normal imports.",
  });
  const output = chunks.join("");
  expect(output).toContain("› zyrk: Preparing installation");
  expect(output).toContain("› zyrk: Verifying package sources");
  expect(output).toContain("Sources verified 2/3 · reused 1 · downloaded 1");
  expect(output).toContain("› zyrk: Preparing shared realizations");
  expect(output).toContain("› zyrk: Linking project dependencies");
  expect(output).toContain("─".repeat(46));
  expect(output).toContain("✓ Installed from the verified shared store.");
  expect(output).toContain(
    "Your project still uses node_modules and normal imports.",
  );
  expect(output.replaceAll("\r\u001b[2K", "")).not.toContain("\u001b");
});

it("renders plain progress without escapes when output is redirected", () => {
  const chunks: string[] = [];
  const ui = createInstallProgress({ write: (s) => chunks.push(s) }, false);
  ui.update({ phase: "planning" });
  ui.update({ phase: "resolving" });
  ui.update({ phase: "fetching", completed: 1, total: 2 });
  ui.close();
  expect(chunks.join("")).toContain("zyrk: Preparing installation");
  expect(chunks.join("")).toContain("zyrk: Verifying package sources (1/2)");
  expect(chunks.join("")).not.toContain("\u001b");
});

it("shows verified source reuse and downloads, and ticks only committed packages", () => {
  const chunks: string[] = [];
  const ui = createInstallProgress({ write: (s) => chunks.push(s) }, false);
  ui.update({
    phase: "fetching",
    completed: 1,
    total: 2,
    reused: 1,
    downloaded: 0,
    package: { name: "@scope/a", version: "1.0.0", status: "reused" },
  });
  ui.update({
    phase: "fetching",
    completed: 1,
    total: 2,
    reused: 1,
    downloaded: 0,
    package: {
      name: "b",
      version: "2.0.0",
      status: "downloading",
      bytes: 4096,
    },
  });
  ui.update({
    phase: "fetching",
    completed: 2,
    total: 2,
    reused: 1,
    downloaded: 1,
    package: { name: "b", version: "2.0.0", status: "downloaded" },
  });
  expect(chunks.join("")).not.toContain("✓");
  ui.update({
    phase: "complete",
    package: { name: "b", version: "2.0.0", status: "linked" },
  });
  ui.close();
  expect(chunks.join("")).toContain("reused 1, downloaded 1");
  expect(chunks.join("")).toContain("Downloading b@2.0.0: 4.0 KiB");
  expect(chunks.join("")).toContain("✓ b@2.0.0 linked");
});
