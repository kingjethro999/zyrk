/** A display-only adaptation of verified create-next-app statement shapes.
 * Official source: v16.4.2 create-app.ts and templates/index.ts. Installer
 * selection and executable logic stay upstream; --skip-install keeps the
 * native zyrk installation separate. Only the private initializer is edited.
 */
import { lstat, readFile, writeFile } from "node:fs/promises";
import { ZyrkError } from "../errors.ts";

export async function adaptNextDisplay(
  script: string,
  version: string,
  skipInstall: boolean,
): Promise<void> {
  const file = await lstat(script);
  if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o200) === 0)
    throw new ZyrkError(
      "ZYRK_INTERNAL",
      "Cannot adapt the Next initializer without an independent writable script.",
      {
        remedy:
          "Retry with a private initializer generation; never make shared store files writable.",
      },
    );
  const original = await readFile(script, "utf8");
  // Match complete neighboring statements, not arbitrary output strings. Minifier
  // variable names can vary; the verified statement structure must match once.
  const header =
    /console\.log\(`Creating a new Next\.js app in \$\{\(0,([A-Za-z_$][\w$]*)\.green\)\(([A-Za-z_$][\w$]*)\)\}\.`\);console\.log\(\);process\.chdir\(\2\);/g;
  const label =
    /console\.log\(\(0,([A-Za-z_$][\w$]*)\.bold\)\(`Using \$\{[A-Za-z_$][\w$]*\}\.`\)\);(?=console\.log\("\\nInitializing project with template:",[A-Za-z_$][\w$]*,"\\n"\);)/g;
  const headers = [...original.matchAll(header)];
  const labels = [...original.matchAll(label)];
  if (
    headers.length !== 1 ||
    labels.length !== 1 ||
    headers[0]![1] !== labels[0]![1]
  )
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      "Cannot adapt the selected Next initializer: its display contract is unsupported.",
      {
        detail: { package: "create-next-app", version },
        remedy:
          "Select create-next-app@16.4.2 or report this version so its upstream display contract can be verified.",
      },
    );
  const message = skipInstall
    ? "Scaffolding only; dependency installation skipped."
    : "Using zyrk.";
  const adapted = original
    .replace(label, "")
    .replace(
      header,
      (statement, color: string, target: string) =>
        statement.slice(0, -`process.chdir(${target});`.length) +
        `console.log((0,${color}.bold)(${JSON.stringify(message)}));console.log();process.chdir(${target});`,
    );
  await writeFile(script, adapted);
}
