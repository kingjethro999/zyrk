"use client";
import { useState } from "react";
import { copyTextToClipboard } from "../../lib/clipboard";

export function DocsCodeBlock({ code }: { code: string }) {
  const [status, setStatus] = useState("");
  async function copy() {
    const copied = await copyTextToClipboard(
      code,
      navigator.clipboard?.writeText
        ? (text) => navigator.clipboard.writeText(text)
        : undefined,
    );
    setStatus(
      copied
        ? "Copied code."
        : "Copy failed. Select the code and copy it manually.",
    );
  }
  return (
    <div className="docs-code-block">
      <pre>
        <code>{code}</code>
      </pre>
      <button type="button" onClick={copy}>
        Copy code
      </button>
      <span role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
