/** Never publish hidden bundled dependency content outside the selected graph. */
import { ZyrkError } from "../errors.ts";
export function assertSupportedSourcePayload(
  subject: { name: string; version: string },
  source: { manifest: { entries: readonly { path: string }[] } },
): void {
  if (
    source.manifest.entries.some(
      (entry) =>
        entry.path === "node_modules" || entry.path.startsWith("node_modules/"),
    )
  )
    throw new ZyrkError(
      "ZYRK_NOT_IMPLEMENTED",
      `Cannot install ${subject.name}@${subject.version}: bundled dependency payloads need an explicit graph adapter.`,
      {
        remedy:
          "Select an unbundled package version or use npm directly for this project; zyrk will not publish a graph that hides bundled dependencies.",
      },
    );
}
