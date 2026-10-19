import { expect, it } from "vitest";
import { sourceProgress, reportLinked } from "../src/install/progress.ts";
import type { InstallProgress } from "../src/install/run.ts";

it("exposes only package presentation fields and never shares graph internals", () => {
  const events: InstallProgress[] = [];
  const node = {
    name: "example",
    version: "1.0.0",
    tarballUrl: "https://registry.invalid/pkg.tgz",
    edges: [{ target: "private-context" }],
  };
  const progress = sourceProgress((e) => events.push(e), 1);
  const bytes = progress.downloading(node);
  bytes(10);
  progress.verified(node, "downloaded");
  reportLinked((e) => events.push(e), [node]);
  expect(events.map((e) => e.package)).toEqual([
    { name: "example", version: "1.0.0", status: "downloading", bytes: 0 },
    { name: "example", version: "1.0.0", status: "downloading", bytes: 10 },
    { name: "example", version: "1.0.0", status: "downloaded" },
    { name: "example", version: "1.0.0", status: "linked" },
  ]);
});
