import { expect, it } from "vitest";
import {
  renderCommandError,
  renderCommandOutput,
} from "../src/cli/terminal.ts";

it("turns structured command results into a readable TTY summary", () => {
  const output = renderCommandOutput(
    "store status",
    '{"schemaVersion":1,"status":"ok","initialized":true,"objects":4}\n',
    { isTTY: true, color: false },
  );
  expect(output).toBe(
    "✓ zyrk store status\n{\n  initialized: true,\n  objects: 4\n}\n",
  );
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
