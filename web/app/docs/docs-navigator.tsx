"use client";
import { useState } from "react";
import { docsIndex, searchDocs } from "../../lib/docs-index";

export function DocsNavigator() {
  const [query, setQuery] = useState("");
  const results = searchDocs(query);
  return (
    <nav className="docs-toc" aria-label="Documentation index">
      <label htmlFor="docs-search">Search documentation</label>
      <input
        id="docs-search"
        type="search"
        maxLength={256}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Commands, concepts, errors…"
        autoComplete="off"
      />
      <p className="docs-search-count" role="status" aria-live="polite">
        {query ? `${results.length} matching sections` : "On this page"}
      </p>
      {results.length ? (
        results.map((entry) => (
          <a key={entry.id} href={`#${entry.id}`}>
            {entry.title}
          </a>
        ))
      ) : (
        <p>No matches. Try an error code or command.</p>
      )}
      {query && (
        <button type="button" onClick={() => setQuery("")}>
          Clear search
        </button>
      )}
      <noscript>
        All documentation sections are listed above. Browser find also searches
        this page.
      </noscript>
    </nav>
  );
}

export function SectionNavigation({ id }: { id: string }) {
  const index = docsIndex.findIndex((entry) => entry.id === id);
  const previous = docsIndex[index - 1],
    next = docsIndex[index + 1];
  return (
    <nav
      className="docs-section-navigation"
      aria-label={`${docsIndex[index]?.title ?? "Section"} navigation`}
    >
      {previous ? <a href={`#${previous.id}`}>← {previous.title}</a> : <span />}
      {next && <a href={`#${next.id}`}>{next.title} →</a>}
    </nav>
  );
}
