import { ZyrkError } from "../errors.ts";

export function completionScript(
  shell: string,
  commands: readonly string[],
): string {
  if (commands.some((command) => !/^[a-z][a-z0-9-]*$/.test(command)))
    throw new ZyrkError(
      "ZYRK_INTERNAL",
      "Cannot generate completion for an unsafe command name.",
    );
  const words = [...new Set(commands)].sort().join(" ");
  switch (shell) {
    case "bash":
      return `# Zyrk static completion: no project scripts or network requests.\n_zyrk_complete() {\n  local current=\"\u0024{COMP_WORDS[COMP_CWORD]}\"\n  COMPREPLY=()\n  if (( COMP_CWORD == 1 )); then\n    while IFS= read -r candidate; do COMPREPLY+=(\"\u0024candidate\"); done < <(compgen -W '${words}' -- \"\u0024current\")\n  elif [[ \"\u0024current\" == -* ]]; then\n    while IFS= read -r candidate; do COMPREPLY+=(\"\u0024candidate\"); done < <(compgen -W '--help --json' -- \"\u0024current\")\n  fi\n}\ncomplete -F _zyrk_complete zyrk\n`;
    case "zsh":
      return `#compdef zyrk\n# Static completion; never runs package code.\n_arguments '1:command:(${words})' '*:option:(--help --json)'\n`;
    case "fish":
      return `# Static completion; never runs package code.\ncomplete -c zyrk -f\ncomplete -c zyrk -n '__fish_use_subcommand' -a '${words}'\ncomplete -c zyrk -l help -d 'Show command help'\ncomplete -c zyrk -l json -d 'Use machine-readable output'\n`;
    default:
      throw new ZyrkError(
        "ZYRK_USAGE",
        "Cannot generate completion for the selected shell.",
        { remedy: "Use zyrk completion bash, zsh, or fish." },
      );
  }
}

/** Suggestions are inert text; only explicit user commands are dispatched. */
export function suggestCommand(
  input: string,
  commands: readonly string[],
): string | undefined {
  if (!/^[a-z-]{3,32}$/.test(input)) return undefined;
  const distance = (a: string, b: string) => {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++)
        row[j] = Math.min(
          row[j - 1]! + 1,
          previous[j]! + 1,
          previous[j - 1]! + Number(a[i - 1] !== b[j - 1]),
        );
      previous = row;
    }
    return previous[b.length]!;
  };
  const ranked = commands
    .map((command) => ({ command, distance: distance(input, command) }))
    .filter((item) => item.distance <= 1)
    .sort(
      (a, b) => a.distance - b.distance || a.command.localeCompare(b.command),
    );
  return ranked.length === 1 ? ranked[0]!.command : undefined;
}
