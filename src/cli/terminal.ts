export type TerminalStyle = { isTTY?: boolean; color?: boolean };

export type HumanSummary = {
  tone: "success" | "attention" | "failure" | "status";
  heading: string;
  facts: string[];
  next?: string;
};

export function renderSummary(
  summary: HumanSummary,
  style: TerminalStyle,
): string {
  const marker = { success: "✓", attention: "!", failure: "✖", status: "›" }[
    summary.tone
  ];
  const color = { success: 32, attention: 33, failure: 31, status: 2 }[
    summary.tone
  ];
  return `${paint(marker, color, style)} ${summary.heading}\n${summary.facts.map((fact) => `  ${fact}\n`).join("")}${summary.next ? `  Next: ${summary.next}\n` : ""}`;
}

/** Command facts stay separate from their terminal presentation and JSON data. */
export function commandSummary(
  command: string,
  value: Record<string, unknown>,
): HumanSummary | undefined {
  if (
    command === "doctor" &&
    typeof value.ok === "boolean" &&
    Array.isArray(value.diagnostics)
  ) {
    const diagnostics = value.diagnostics as Array<{
      severity: string;
      code: string;
      message: string;
    }>;
    return {
      tone: !value.ok
        ? "failure"
        : diagnostics.length
          ? "attention"
          : "success",
      heading: !value.ok
        ? "Project needs attention"
        : diagnostics.length
          ? "Project checks passed with warnings"
          : "Project checks passed",
      facts: diagnostics.length
        ? diagnostics.map((d) => `${d.severity}: ${d.code}: ${d.message}`)
        : ["Lock, links, build readiness, and store safety checked."],
      ...(!value.ok
        ? {
            next: "Review these diagnostics before choosing install or repair.",
          }
        : {}),
    };
  }
  if (command.startsWith("store") && typeof value.initialized === "boolean") {
    return {
      tone: "status",
      heading: value.initialized
        ? "Shared store status"
        : "Shared store is not initialized",
      facts: value.initialized
        ? [
            `Retention roots: ${value.retentionRoots ?? "unavailable"}`,
            `Logical bytes: ${value.logicalBytes ?? "unavailable"}`,
            `Allocated bytes estimate: ${value.allocatedBytesEstimate ?? "unavailable"}`,
            String(
              value.allocationMethod ??
                "Physical allocation measurement unavailable.",
            ),
            "Private builds, fetch caches, and exclusive reclaimable bytes are not measured here.",
          ]
        : ["No store content has been inspected."],
    };
  }
  if (command.startsWith("store") && value.verified === true)
    return {
      tone: "success",
      heading: "Shared store verification passed",
      facts: [
        `Sources: ${value.sources}; objects: ${value.objects}; realizations: ${value.realizations}`,
      ],
    };
  if (
    command.startsWith("store") &&
    typeof value.dryRun === "boolean" &&
    Array.isArray(value.candidates)
  )
    return {
      tone: "status",
      heading: value.dryRun
        ? "Store collection preview"
        : "Store collection complete",
      facts: [
        `Eligible entries: ${value.candidates.length}; removed: ${value.removed}; retained: ${value.retained}`,
        `Within grace period: ${value.graceRetained}`,
        `Selected logical bytes: ${value.logicalBytesSelected}; physical bytes reclaimed: ${value.physicalBytesReclaimed}`,
        ...(Array.isArray(value.retentionReasons)
          ? value.retentionReasons.map(String)
          : []),
      ],
      ...(value.dryRun
        ? { next: "Review eligibility; run zyrk store gc to apply collection." }
        : {}),
    };
  if (value.status === "unavailable")
    return {
      tone: "attention",
      heading: `${command} is unavailable`,
      facts: [
        "No clean result can be established.",
        ...Object.entries(value)
          .filter(
            ([key]) => !["schemaVersion", "status", "command"].includes(key),
          )
          .map(([key, item]) => `${key}: ${JSON.stringify(item)}`),
      ],
    };
  return undefined;
}

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
    const semantic = commandSummary(command, value as Record<string, unknown>);
    if (semantic) return renderSummary(semantic, style);
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
