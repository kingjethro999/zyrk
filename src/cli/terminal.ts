export type TerminalStyle = { isTTY?: boolean; color?: boolean };

function paint(value: string, code: number, style: TerminalStyle): string {
  return style.isTTY && style.color !== false
    ? `\u001b[${code}m${value}\u001b[0m`
    : value;
}

/** Render command summaries for people while preserving redirected output. */
export function renderCommandOutput(
  command: string,
  output: string,
  style: TerminalStyle = {},
): string {
  if (!style.isTTY || output === "") return output;
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    value = undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const summary = { ...(value as Record<string, unknown>) };
    delete summary.schemaVersion;
    delete summary.status;
    delete summary.command;
    const body = JSON.stringify(summary, null, 2).replace(
      /^(\s*)"([^\"]+)":/gm,
      (_match, indent: string, key: string) =>
        `${indent}${paint(`${key}:`, 2, style)}`,
    );
    return `${paint("✓", 32, style)} zyrk ${command}\n${body}\n`;
  }
  const lines = output.trimEnd().split("\n");
  const first = lines.shift() ?? "";
  const heading = first.startsWith("✓")
    ? `${paint("✓", 32, style)}${first.slice(1)}`
    : `${paint("✓", 32, style)} ${first}`;
  return `${heading}${lines.length ? `\n${lines.join("\n")}` : ""}\n`;
}

/** Make stable CLI diagnostics easier to scan without changing their content. */
export function renderCommandError(
  error: string,
  style: TerminalStyle = {},
): string {
  if (!style.isTTY) return error;
  const match = /^zyrk: error ([A-Z0-9_]+): ([^\n]+)(?:\n([\s\S]*?))?\n?$/.exec(
    error,
  );
  if (!match) return error;
  const [, code, message, remedy] = match;
  return `${paint("✖", 31, style)} zyrk ${code}\n  ${message}${
    remedy ? `\n  ${paint("↳", 33, style)} ${remedy}` : ""
  }\n`;
}
