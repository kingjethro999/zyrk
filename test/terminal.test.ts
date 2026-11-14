import { expect, it } from "vitest";
import {
  renderCommandError,
  renderCommandOutput,
  renderSessionEnd,
  renderSessionStart,
} from "../src/cli/terminal.ts";

it("turns structured command results into a readable TTY summary", () => {
  const output = renderCommandOutput(
    "store status",
    '{"schemaVersion":1,"status":"ok","initialized":true,"objects":4}\n',
    { isTTY: true, color: false },
  );
  expect(output).toBe(
    "› Shared store status\n  Retention roots: unavailable\n  Logical bytes: unavailable\n  Allocated bytes estimate: unavailable\n  Physical allocation measurement unavailable.\n  Private builds, fetch caches, and exclusive reclaimable bytes are not measured here.\n",
  );
});

it("never paints failing doctor or unavailable audit results as success", () => {
  const doctor = renderCommandOutput(
    "doctor",
    JSON.stringify({
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "ZYRK_LOCK_MISMATCH",
          message: "Lock differs.",
        },
      ],
    }),
    { isTTY: true, color: false },
  );
  expect(doctor).toContain("✖ Project needs attention");
  expect(doctor).not.toContain("✓");
  const audit = renderCommandOutput("audit", '{"status":"unavailable"}', {
    isTTY: true,
    color: false,
  });
  expect(audit).toContain("! audit is unavailable");
  expect(audit).not.toContain("✓");
  expect(audit).not.toContain("\u001b");
});

it("keeps redirected command output byte-for-byte unchanged", () => {
  const output = '{"schemaVersion":1,"status":"ok"}\n';
  expect(renderCommandOutput("store status", output)).toBe(output);
});

it("formats actionable errors for a TTY and preserves plain diagnostics", () => {
  const error =
    "zyrk: error ZYRK_LOCK_MISMATCH: The installed graph disagrees.\nRun zyrk install and retry.\n";
  expect(renderCommandError(error, { isTTY: true, color: false })).toBe(
    "✖ zyrk ZYRK_LOCK_MISMATCH\n  The installed graph disagrees.\n  ↳ Run zyrk install and retry.\n",
  );
  expect(renderCommandError(error)).toBe(error);
});

it("frames project sessions with their script, outcome, and wall time", () => {
  const plain = { isTTY: true, color: false };
  expect(
    renderSessionStart(
      { command: "run", name: "dev", script: "next dev\u001b[2J --port 5199" },
      plain,
    ),
  ).toBe("› zyrk run dev  next dev [2J --port 5199\n");
  expect(renderSessionStart({ command: "exec", name: "tsc" }, plain)).toBe(
    "› zyrk exec tsc\n",
  );
  expect(
    renderSessionEnd({ name: "build", exitCode: 0, durationMs: 1234 }, plain),
  ).toBe("✓ build finished in 1.2s\n");
  expect(
    renderSessionEnd({ name: "build", exitCode: 2, durationMs: 61_000 }, plain),
  ).toBe("✖ build exited with code 2 in 1m 01s\n");
  // Ctrl-C on a dev server is a requested stop, never painted as a failure.
  expect(
    renderSessionEnd({ name: "dev", exitCode: 130, durationMs: 500 }, plain),
  ).toBe("! dev stopped in 0.5s\n");
  expect(
    renderSessionEnd(
      { name: "dev", exitCode: 0, durationMs: 500 },
      {
        isTTY: true,
      },
    ),
  ).toContain("\u001b[32m✓\u001b[0m");
});
