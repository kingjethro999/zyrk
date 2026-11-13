import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import {
  promptForBuildApproval,
  promptInteractive,
  promptFallback,
} from "../src/cli/build-approval-prompt.ts";
import type { BuildCandidate } from "../src/install/private.ts";

const sampleBuilds: readonly BuildCandidate[] = [
  {
    key: "unrs-resolver@1.12.2",
    name: "unrs-resolver",
    version: "1.12.2",
    sourceId: "src1_20ad59f657786841959b40d948a3a6e9bcc4836a",
    stages: [{ name: "postinstall", command: "node postinstall.js" }],
  },
  {
    key: "esbuild@0.25.0",
    name: "esbuild",
    version: "0.25.0",
    sourceId: "src1_9a123f456789abcdef0123456789abcdef012345",
    stages: [{ name: "postinstall", command: "node install.js" }],
  },
];

class MockInput extends PassThrough {
  isTTY = true;
  rawMode = false;

  setRawMode(mode: boolean): this {
    this.rawMode = mode;
    return this;
  }

  pressKey(str: string, key?: Record<string, unknown>): void {
    const keyObj = {
      sequence: str,
      name: key?.name ?? str,
      ctrl: key?.ctrl ?? false,
      meta: key?.meta ?? false,
      shift: key?.shift ?? false,
      ...key,
    };
    this.emit("keypress", str, keyObj);
  }
}

class MockOutput {
  isTTY = true;
  buffer = "";

  write(chunk: string): boolean {
    this.buffer += chunk;
    return true;
  }
}

describe("promptFallback", () => {
  it("skips and returns empty array on empty input", async () => {
    const input = new PassThrough();
    const output = new MockOutput();
    const promise = promptFallback(sampleBuilds, input, output);
    input.write("\n");
    const result = await promise;
    expect(result).toEqual([]);
    expect(output.buffer).toContain("Dependency build approval");
    expect(output.buffer).toContain("unrs-resolver@1.12.2");
  });

  it("approves all on 'all'", async () => {
    const input = new PassThrough();
    const output = new MockOutput();
    const promise = promptFallback(sampleBuilds, input, output);
    input.write("all\n");
    const result = await promise;
    expect(result).toEqual(["*"]);
  });

  it("approves selected numbers", async () => {
    const input = new PassThrough();
    const output = new MockOutput();
    const promise = promptFallback(sampleBuilds, input, output);
    input.write("1, 2\n");
    const result = await promise;
    expect(result).toEqual([
      "src1_20ad59f657786841959b40d948a3a6e9bcc4836a",
      "src1_9a123f456789abcdef0123456789abcdef012345",
    ]);
  });

  it("skips on 's'", async () => {
    const input = new PassThrough();
    const output = new MockOutput();
    const promise = promptFallback(sampleBuilds, input, output);
    input.write("s\n");
    const result = await promise;
    expect(result).toEqual([]);
  });

  it("aborts safely on 'q'", async () => {
    const input = new PassThrough();
    const output = new MockOutput();
    const promise = promptFallback(sampleBuilds, input, output);
    input.write("q\n");
    await expect(promise).rejects.toThrow(
      "Installation cancelled by user during build approval.",
    );
  });

  it("rejects invalid candidate numbers", async () => {
    const input = new PassThrough();
    const output = new MockOutput();
    const promise = promptFallback(sampleBuilds, input, output);
    input.write("99\n");
    await expect(promise).rejects.toThrow(
      "Build selection contains an invalid candidate number.",
    );
  });
});

describe("promptInteractive", () => {
  it("navigates, toggles with Space, and confirms with Enter", async () => {
    const input = new MockInput();
    const output = new MockOutput();
    const promise = promptInteractive(sampleBuilds, input, output, {
      NO_COLOR: "1",
    });

    // Initial render should show candidates
    expect(output.buffer).toContain("unrs-resolver@1.12.2");
    expect(output.buffer).toContain("esbuild@0.25.0");
    expect(output.buffer).toContain("Status: 0 of 2 approved");

    // Space toggles candidate 0 (unrs-resolver)
    input.pressKey(" ", { name: "space" });
    expect(output.buffer).toContain("Status: 1 of 2 approved");

    // Enter confirms
    input.pressKey("\r", { name: "return" });
    const result = await promise;

    expect(result).toEqual(["src1_20ad59f657786841959b40d948a3a6e9bcc4836a"]);
    expect(output.buffer).toContain(
      "Approved 1 build source(s) (saved to zyrk-workspace.json)",
    );
    expect(input.rawMode).toBe(false);
  });

  it("selects all with 'a' and confirms with Enter", async () => {
    const input = new MockInput();
    const output = new MockOutput();
    const promise = promptInteractive(sampleBuilds, input, output, {
      NO_COLOR: "1",
    });

    // Press 'a' to select all
    input.pressKey("a");
    expect(output.buffer).toContain("Status: 2 of 2 approved");

    // Enter confirms all
    input.pressKey("\r", { name: "return" });
    const result = await promise;

    expect(result).toEqual(["*"]);
    expect(output.buffer).toContain("Approved all 2 build sources");
  });

  it("toggles all off if 'a' is pressed when all are selected", async () => {
    const input = new MockInput();
    const output = new MockOutput();
    const promise = promptInteractive(sampleBuilds, input, output, {
      NO_COLOR: "1",
    });

    // Select all
    input.pressKey("a");
    expect(output.buffer).toContain("Status: 2 of 2 approved");

    // Deselect all
    input.pressKey("a");
    expect(output.buffer).toContain("Status: 0 of 2 approved");

    // Enter with 0 selected completes unbuilt
    input.pressKey("\r", { name: "return" });
    const result = await promise;

    expect(result).toEqual([]);
    expect(output.buffer).toContain(
      "No builds approved; continuing intentionally unbuilt",
    );
  });

  it("skips directly with 's'", async () => {
    const input = new MockInput();
    const output = new MockOutput();
    const promise = promptInteractive(sampleBuilds, input, output, {
      NO_COLOR: "1",
    });

    input.pressKey("s");
    const result = await promise;

    expect(result).toEqual([]);
    expect(output.buffer).toContain(
      "Skipping pending scripts; continuing intentionally unbuilt",
    );
    expect(input.rawMode).toBe(false);
  });

  it("aborts cleanly with 'q'", async () => {
    const input = new MockInput();
    const output = new MockOutput();
    const promise = promptInteractive(sampleBuilds, input, output, {
      NO_COLOR: "1",
    });

    input.pressKey("q");
    await expect(promise).rejects.toThrow(
      "Installation cancelled by user during build approval.",
    );
    expect(output.buffer).toContain("Build approval cancelled");
    expect(input.rawMode).toBe(false);
  });

  it("aborts cleanly with Ctrl+C", async () => {
    const input = new MockInput();
    const output = new MockOutput();
    const promise = promptInteractive(sampleBuilds, input, output, {
      NO_COLOR: "1",
    });

    input.pressKey("\u0003", {
      name: "c",
      ctrl: true,
    });
    await expect(promise).rejects.toThrow(
      "Installation cancelled by user during build approval.",
    );
    expect(output.buffer).toContain("Build approval cancelled");
    expect(input.rawMode).toBe(false);
  });

  it("navigates with up/down arrows and toggles with number keys", async () => {
    const input = new MockInput();
    const output = new MockOutput();
    const promise = promptInteractive(sampleBuilds, input, output, {
      NO_COLOR: "1",
    });

    // Press '2' to jump to candidate 2 and toggle it
    input.pressKey("2");
    expect(output.buffer).toContain("Status: 1 of 2 approved");

    // Press down arrow
    input.pressKey("\u001b[B", { name: "down" });
    // Press 'k' (up)
    input.pressKey("k");

    // Enter confirms candidate 2
    input.pressKey("\r", { name: "return" });
    const result = await promise;

    expect(result).toEqual(["src1_9a123f456789abcdef0123456789abcdef012345"]);
  });
});

describe("promptForBuildApproval dispatcher", () => {
  it("dispatches to fallback when not TTY", async () => {
    const input = new PassThrough();
    const output = new MockOutput();
    output.isTTY = false;

    const promise = promptForBuildApproval(sampleBuilds, input, output);
    input.write("\n");
    const result = await promise;
    expect(result).toEqual([]);
  });

  it("dispatches to interactive when TTY with setRawMode", async () => {
    const input = new MockInput();
    const output = new MockOutput();

    const promise = promptForBuildApproval(sampleBuilds, input, output, {
      NO_COLOR: "1",
    });
    input.pressKey("s");
    const result = await promise;
    expect(result).toEqual([]);
  });
});
