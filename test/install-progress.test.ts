import { expect, it, vi } from "vitest";
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

it("marks intentionally unbuilt completion as attention without color", () => {
  const chunks: string[] = [];
  const ui = createInstallProgress(
    { isTTY: true, write: (s) => chunks.push(s) },
    false,
    { color: false },
  );
  ui.close({
    tone: "attention",
    title: "Installed; dependency builds were skipped.",
    detail: "Review build policy.",
  });
  expect(chunks.join("")).toContain(
    "! Installed; dependency builds were skipped.",
  );
  expect(chunks.join("")).not.toContain("✓");
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

it("bounds redirected progress and flushes the latest source totals on close", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const chunks: string[] = [];
    const ui = createInstallProgress({ write: (s) => chunks.push(s) }, false);
    ui.update({ phase: "planning" });
    for (let completed = 0; completed < 500; completed++)
      ui.update({
        phase: "fetching",
        completed,
        total: 600,
        reused: completed,
        downloaded: 0,
      });
    expect(chunks.length).toBeLessThanOrEqual(3);
    ui.close();
    expect(chunks.join("")).toContain("(499/600) — reused 499, downloaded 0");
    const output = chunks.join("");
    ui.close();
    ui.update({ phase: "linking" });
    expect(chunks.join("")).toBe(output);
    expect(output).not.toContain("\u001b");
  } finally {
    clock.mockRestore();
  }
});

it("flushes pending counts before changing stage and omits unknown totals", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const chunks: string[] = [];
    const ui = createInstallProgress({ write: (s) => chunks.push(s) }, false);
    ui.update({ phase: "fetching", completed: 1 });
    ui.update({ phase: "fetching", completed: 2, total: 3 });
    ui.update({ phase: "realizing" });
    ui.close();
    const output = chunks.join("");
    expect(output.indexOf("(2/3)")).toBeLessThan(
      output.indexOf("Preparing shared realizations"),
    );
    expect(output).not.toContain("/0");
  } finally {
    clock.mockRestore();
  }
});

it("reports periodic download bytes and final counts without a success on failure", () => {
  let now = 1000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const chunks: string[] = [];
    const ui = createInstallProgress({ write: (s) => chunks.push(s) }, false);
    const downloading = (bytes: number) =>
      ui.update({
        phase: "fetching",
        package: {
          name: "large",
          version: "1.0.0",
          status: "downloading",
          bytes,
        },
      });
    downloading(1024);
    downloading(2048);
    expect(chunks.join("")).not.toContain("2.0 KiB");
    now += 1000;
    downloading(4096);
    expect(chunks.join("")).toContain("4.0 KiB");
    downloading(8192);
    ui.close();
    expect(chunks.join("")).toContain("8.0 KiB");
    expect(chunks.join("")).not.toContain("✓");
  } finally {
    clock.mockRestore();
  }
});
