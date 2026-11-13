import { createInterface } from "node:readline/promises";
import readline from "node:readline";
import type { BuildCandidate } from "../install/private.ts";
import { redactSecrets } from "../log.ts";
import { ZyrkError } from "../errors.ts";

export type BuildApprovalStream = {
  write(chunk: string): unknown;
  isTTY?: boolean;
};

export type BuildApprovalInput = NodeJS.ReadableStream & {
  setRawMode?(mode: boolean): unknown;
  isTTY?: boolean;
  pause?(): unknown;
  resume?(): unknown;
};

function formatStages(build: BuildCandidate): string {
  return build.stages
    .map(
      (stage) =>
        `${stage.name}: ${redactSecrets(stage.command)
          .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
          .slice(0, 180)}`,
    )
    .join("; ");
}

/**
 * Fallback prompt for non-interactive / piped environments.
 * Retains comma-separated digits, `all`, and Enter-to-skip semantics.
 */
export async function promptFallback(
  builds: readonly BuildCandidate[],
  input: NodeJS.ReadableStream,
  output: BuildApprovalStream,
): Promise<string[]> {
  output.write(
    "\nDependency build approval\nScripts run with your OS account permissions; approval is not a sandbox.\nSelected exact-source approvals are saved to zyrk-workspace.json for collaborators.\n\n",
  );
  builds.forEach((build, index) => {
    output.write(
      `  ${index + 1}. [ ] ${build.name}@${build.version}\n     source: ${build.sourceId}\n     lifecycle: ${formatStages(build)}\n`,
    );
  });
  output.write(
    "Enter numbers separated by commas to approve selected sources, `all` to approve all listed sources, or press Enter to skip pending scripts and continue intentionally unbuilt.\n",
  );
  const prompt = createInterface({
    input,
    output: output as NodeJS.WritableStream,
    terminal: false,
  });
  try {
    const answer = (await prompt.question("Approve builds> ")).trim();
    if (!answer) return [];
    const lower = answer.toLowerCase();
    if (lower === "all") return ["*"];
    if (lower === "s" || lower === "skip") return [];
    if (lower === "q" || lower === "cancel" || lower === "abort") {
      throw new ZyrkError(
        "ZYRK_USAGE",
        "Installation cancelled by user during build approval.",
        {
          remedy:
            "Re-run zyrk install when ready to review dependency builds, or pass --ignore-scripts to skip builds.",
        },
      );
    }
    const numbers = answer.split(/[ ,]+/).map((value: string) => Number(value));
    if (
      numbers.some(
        (number: number) =>
          !Number.isInteger(number) || number < 1 || number > builds.length,
      )
    ) {
      throw new ZyrkError(
        "ZYRK_USAGE",
        "Build selection contains an invalid candidate number.",
        {
          remedy: `Select numbers from 1 to ${builds.length}, enter all, or press Enter to skip scripts.`,
        },
      );
    }
    return [...new Set<number>(numbers)].map(
      (number: number) => builds[number - 1]!.sourceId,
    );
  } finally {
    prompt.close();
  }
}

/**
 * Interactive single-key terminal prompt for build approvals.
 * Space toggles [x], Enter confirms, a selects all, s skips, q/Ctrl+C cancels safely.
 */
export async function promptInteractive(
  builds: readonly BuildCandidate[],
  input: BuildApprovalInput,
  output: BuildApprovalStream,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const color = env.NO_COLOR === undefined && env.TERM !== "dumb";
  const dim = (v: string) => (color ? `\u001b[2m${v}\u001b[0m` : v);
  const bold = (v: string) => (color ? `\u001b[1m${v}\u001b[0m` : v);
  const cyan = (v: string) => (color ? `\u001b[36m${v}\u001b[0m` : v);
  const green = (v: string) => (color ? `\u001b[32m${v}\u001b[0m` : v);

  let focusedIndex = 0;
  const selected = new Set<number>();
  let renderedLines = 0;

  function renderFrame(): string {
    const lines: string[] = [];
    lines.push(
      "Dependency build approval",
      dim(
        "Scripts run with your OS account permissions; approval is not a sandbox.",
      ),
      dim(
        "Selected exact-source approvals are saved to zyrk-workspace.json for collaborators.",
      ),
      "",
    );

    builds.forEach((build, index) => {
      const isFocused = index === focusedIndex;
      const isChecked = selected.has(index);
      const pointer = isFocused ? cyan("❯ ") : "  ";
      const checkbox = isChecked ? green("[x]") : "[ ]";
      const header = `${index + 1}. ${build.name}@${build.version}`;
      lines.push(
        `${pointer}${checkbox} ${isFocused ? bold(header) : header}`,
        `     source: ${dim(build.sourceId)}`,
        `     lifecycle: ${dim(formatStages(build))}`,
      );
    });

    lines.push(
      dim("─".repeat(56)),
      `Status: ${bold(`${selected.size} of ${builds.length}`)} approved${
        selected.size === 0 ? dim(" (will continue unbuilt)") : ""
      }`,
      dim(
        "[↑/↓] Navigate  •  [Space] Toggle  •  [a] All  •  [s] Skip  •  [Enter] Confirm  •  [q] Cancel",
      ),
    );

    return lines.join("\n") + "\n";
  }

  return new Promise<string[]>((resolve, reject) => {
    let completed = false;

    const cleanup = () => {
      if (completed) return;
      completed = true;
      try {
        input.removeListener("keypress", onKeypress);
      } catch {}
      try {
        if (typeof input.setRawMode === "function") {
          input.setRawMode(false);
        }
      } catch {}
      try {
        output.write("\u001b[?25h"); // show cursor
      } catch {}
      try {
        if (typeof input.pause === "function") {
          input.pause();
        }
      } catch {}
    };

    const draw = (isFirst: boolean) => {
      const content = renderFrame();
      if (!isFirst && renderedLines > 0) {
        output.write(`\u001b[${renderedLines}A\r\u001b[0J`);
      }
      output.write(content);
      renderedLines = content.split("\n").length - 1;
    };

    const finish = (result: string[] | Error) => {
      cleanup();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };

    const onKeypress = (
      _str: string | undefined,
      key: readline.Key | undefined,
    ) => {
      if (completed) return;
      const k = key?.name;
      const ch = key?.sequence ?? _str ?? "";

      // Ctrl+C or 'q' / 'Q' -> safe abort
      if ((key?.ctrl && k === "c") || k === "q" || ch === "q" || ch === "Q") {
        output.write("\n› Build approval cancelled.\n");
        finish(
          new ZyrkError(
            "ZYRK_USAGE",
            "Installation cancelled by user during build approval.",
            {
              remedy:
                "Re-run zyrk install when ready to review dependency builds, or pass --ignore-scripts to skip builds.",
            },
          ),
        );
        return;
      }

      // Up arrow or 'k'
      if (k === "up" || ch === "k" || ch === "K") {
        focusedIndex = (focusedIndex - 1 + builds.length) % builds.length;
        draw(false);
        return;
      }

      // Down arrow or 'j'
      if (k === "down" || ch === "j" || ch === "J") {
        focusedIndex = (focusedIndex + 1) % builds.length;
        draw(false);
        return;
      }

      // Space -> toggle focused
      if (k === "space" || ch === " ") {
        if (selected.has(focusedIndex)) {
          selected.delete(focusedIndex);
        } else {
          selected.add(focusedIndex);
        }
        draw(false);
        return;
      }

      // 'a' or 'A' -> toggle all
      if (ch === "a" || ch === "A") {
        if (selected.size === builds.length) {
          selected.clear();
        } else {
          for (let i = 0; i < builds.length; i++) {
            selected.add(i);
          }
        }
        draw(false);
        return;
      }

      // 's' or 'S' -> skip unbuilt
      if (ch === "s" || ch === "S") {
        output.write(
          "\n› Skipping pending scripts; continuing intentionally unbuilt.\n",
        );
        finish([]);
        return;
      }

      // Number keys '1'..'9' -> jump and toggle
      if (/^[1-9]$/.test(ch)) {
        const num = Number(ch);
        if (num >= 1 && num <= builds.length) {
          focusedIndex = num - 1;
          if (selected.has(focusedIndex)) {
            selected.delete(focusedIndex);
          } else {
            selected.add(focusedIndex);
          }
          draw(false);
        }
        return;
      }

      // Enter / Return -> confirm selection
      if (k === "return" || k === "enter" || ch === "\r" || ch === "\n") {
        if (selected.size === 0) {
          output.write(
            "\n› No builds approved; continuing intentionally unbuilt.\n",
          );
          finish([]);
          return;
        }
        if (selected.size === builds.length) {
          output.write(
            `\n› Approved all ${builds.length} build sources (saved to zyrk-workspace.json).\n`,
          );
          finish(["*"]);
          return;
        }
        const chosen = [...selected]
          .sort((a, b) => a - b)
          .map((i) => builds[i]!.sourceId);
        output.write(
          `\n› Approved ${chosen.length} build source(s) (saved to zyrk-workspace.json).\n`,
        );
        finish(chosen);
        return;
      }
    };

    try {
      if (typeof input.setRawMode === "function") {
        input.setRawMode(true);
      }
      if (typeof input.resume === "function") {
        input.resume();
      }
      readline.emitKeypressEvents(input);
      input.on("keypress", onKeypress);
      output.write("\u001b[?25l"); // hide cursor
      output.write("\n");
      draw(true);
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * Main prompt dispatcher: chooses interactive single-key UI when terminal raw mode
 * is supported on TTY, or deterministic fallback line prompt otherwise.
 */
export async function promptForBuildApproval(
  builds: readonly BuildCandidate[],
  input: BuildApprovalInput,
  output: BuildApprovalStream,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const isInteractive =
    Boolean(input.isTTY) &&
    typeof input.setRawMode === "function" &&
    Boolean(output.isTTY);

  if (isInteractive) {
    return promptInteractive(builds, input, output, env);
  }
  return promptFallback(builds, input, output);
}
