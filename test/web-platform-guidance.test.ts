import { describe, expect, it } from "vitest";
import {
  bootstrapCommand,
  platformGuidance,
} from "../web/lib/platform-guidance.ts";

describe("website platform guidance", () => {
  it("keeps the bootstrap requirement consistent across every platform", () => {
    expect(bootstrapCommand).toBe("npm install --global zyrk");
    expect(platformGuidance).toHaveLength(3);
    expect(platformGuidance.every((item) => item.summary.length > 20)).toBe(
      true,
    );
  });

  it("offers native project installation only for the current initial target", () => {
    expect(
      platformGuidance
        .filter((item) => item.projectCommand !== null)
        .map((item) => item.id),
    ).toEqual(["linux"]);
    expect(platformGuidance.find((item) => item.id === "linux")).toMatchObject({
      status: "initial-target",
      projectCommand: "zyrk install",
    });
  });

  it("makes the Windows ACL gate explicit and supplies no install command", () => {
    const windows = platformGuidance.find((item) => item.id === "windows");
    expect(windows).toMatchObject({
      status: "unavailable",
      projectCommand: null,
    });
    expect(windows?.evidence).toContain("account-isolating ACL");
  });
});
