export type DocsEntry = { id: string; title: string; text: string };
export const docsIndex: readonly DocsEntry[] = [
  {
    id: "getting-started",
    title: "Getting started",
    text: "Node.js 24 npm bootstrap install package.json project scripts dev frozen offline prerequisites",
  },
  {
    id: "how-it-works",
    title: "How it works",
    text: "Shared store verified source integrity immutable realizations dependency peer context node_modules portable lockfile transaction",
  },
  {
    id: "commands",
    title: "Command reference",
    text: "install add remove update run exec dev dlx create approve-builds completion doctor repair store gc projects import deploy docker audit patch why list",
  },
  {
    id: "compatibility",
    title: "Compatibility",
    text: "Linux macOS Windows ACL Node.js Next.js webpack turbopack native exports ELF N-API frameworks platforms",
  },
  {
    id: "script-trust",
    title: "Script trust",
    text: "preinstall install postinstall approve-builds rebuild revoke deniedBuilds zyrk-workspace.json permissions sandbox private builds",
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    text: "ZYRK_LOCK_MISMATCH ZYRK_RESOLUTION_FAILED ZYRK_OFFLINE_MISSING network timeout deadline milliseconds slow connections missing script repair doctor global",
  },
  {
    id: "sources",
    title: "Sources and policies",
    text: "README security reporting contribution license compatibility evidence github releases limitations",
  },
];

/** Local-only search: text is treated as data, never HTML or a regular expression. */
export function searchDocs(
  query: string,
  entries: readonly DocsEntry[] = docsIndex,
): readonly DocsEntry[] {
  const words = query
    .slice(0, 256)
    .trim()
    .toLocaleLowerCase("en")
    .split(/\s+/)
    .filter(Boolean);
  return entries.filter((entry) =>
    words.every((word) =>
      `${entry.title} ${entry.text}`.toLocaleLowerCase("en").includes(word),
    ),
  );
}
