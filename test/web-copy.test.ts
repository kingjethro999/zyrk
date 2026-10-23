import { describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../web/lib/clipboard.ts";

describe("copyTextToClipboard", () => {
  it("copies the exact command when clipboard writing succeeds", async () => {
    const write = vi.fn(async (_text: string) => {});

    await expect(
      copyTextToClipboard("npm install --global zyrk", write),
    ).resolves.toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith("npm install --global zyrk");
  });

  it("reports unavailable clipboard access so the UI can offer manual selection", async () => {
    await expect(
      copyTextToClipboard("npm install --global zyrk", undefined),
    ).resolves.toBe(false);
  });

  it("does not claim success when clipboard permission is denied", async () => {
    const write = vi.fn(async (_text: string) => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });

    await expect(
      copyTextToClipboard("npm install --global zyrk", write),
    ).resolves.toBe(false);
  });
});
