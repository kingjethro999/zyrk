import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { completionScript, suggestCommand } from "../src/cli/completion.ts";
import { runCli } from "../src/cli/main.ts";

it.each(["bash", "zsh", "fish"])(
  "generates %s completion without project or network effects",
  async (shell) => {
    let output = "";
    const code = await runCli({
      argv: ["completion", shell],
      cwd: "/does-not-exist",
      env: {},
      stdout: {
        isTTY: true,
        write: (v) => {
          output += v;
        },
      },
      stderr: {
        write: () => {
          throw Error("unexpected diagnostic");
        },
      },
      tools: async () => {
        throw Error("unexpected store or registry initialization");
      },
    });
    expect(code).toBe(0);
    expect(output).toContain("install");
    expect(output).toContain("approve-builds");
    expect(output).not.toContain("✓");
    expect(output).not.toContain("\u001b");
  },
);

it("emits syntactically valid Bash and completes a prefix without executing code", () => {
  const script = completionScript("bash", ["install", "import", "add"]);
  execFileSync("bash", ["-n"], { input: script });
  const result = execFileSync(
    "bash",
    [
      "-c",
      script +
        '\nCOMP_WORDS=(zyrk ins); COMP_CWORD=1; _zyrk_complete; printf "%s\\n" "${COMPREPLY[@]}"',
    ],
    { encoding: "utf8" },
  );
  expect(result.trim()).toBe("install");
});

it("rejects shell injection and unsupported shells", () => {
  for (const command of ["x;touch pwned", "$(id)", "éxecute", "two words"])
    expect(() => completionScript("bash", [command])).toThrow();
  expect(() => completionScript("powershell", ["install"])).toThrow();
});

it("suggests only unambiguous close commands and never interprets hostile values", () => {
  expect(suggestCommand("instal", ["install", "import"])).toBe("install");
  expect(suggestCommand("foo", ["foe", "for"])).toBeUndefined();
  expect(
    suggestCommand("https://user:secret@example.test", ["install"]),
  ).toBeUndefined();
});
