import { expect, it, vi } from "vitest";
import { createInstallProgress } from "../src/cli/progress.ts";

it("renders plain progress without escapes and remains quiet for JSON", () => {
  const chunks: string[] = [];
  const stream = { write: (s: string) => chunks.push(s) };
  const ui = createInstallProgress(stream, false);
  ui.update({ phase: "resolving" });
  ui.update({ phase: "fetching", completed: 1, total: 2 });
  ui.close();
  expect(chunks.join("")).toContain("Resolving dependencies");
  expect(chunks.join("")).toContain("1/2");
  expect(chunks.join("")).not.toContain("\u001b");
  const before = chunks.join("");
  const quiet = createInstallProgress(stream, true);
  quiet.update({ phase: "resolving" });
  quiet.close();
  expect(chunks.join("")).toBe(before);
});

it("stops the TTY spinner when closed on success or error", () => {
  vi.useFakeTimers();
  try {
    const chunks: string[] = [];
    const ui = createInstallProgress(
      { isTTY: true, write: (s) => chunks.push(s) },
      false,
    );
    ui.update({ phase: "fetching", completed: 0, total: 3 });
    vi.advanceTimersByTime(250);
    expect(chunks.length).toBeGreaterThan(1);
    ui.close();
    const count = chunks.length;
    vi.advanceTimersByTime(1000);
    expect(chunks.length).toBe(count);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
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
