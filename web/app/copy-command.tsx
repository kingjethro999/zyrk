"use client";

import { useState } from "react";
import { copyTextToClipboard } from "../lib/clipboard";

type CopyCommandProps = {
  command: string;
};

export function CopyCommand({ command }: CopyCommandProps) {
  const [status, setStatus] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");

  async function handleCopy() {
    setStatus("copying");
    const copied = await copyTextToClipboard(command, async (text) => {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable.");
      }
      await navigator.clipboard.writeText(text);
    });
    setStatus(copied ? "copied" : "failed");
  }

  const message =
    status === "copied"
      ? "Copied the command to the clipboard."
      : status === "failed"
        ? "Could not copy. Select the command and copy it manually."
        : "";

  return (
    <div className="copy-command">
      <code>
        <span aria-hidden="true">$</span> {command}
      </code>
      <button
        className="copy-button"
        type="button"
        onClick={handleCopy}
        disabled={status === "copying"}
        aria-label="Copy install command"
      >
        {status === "copied" ? "Copied" : "Copy"}
      </button>
      <span
        className="copy-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {message}
      </span>
    </div>
  );
}
