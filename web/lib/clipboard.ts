export type ClipboardWriter = (text: string) => Promise<void>;

/** Copy text only after a caller's explicit action; report denied APIs safely. */
export async function copyTextToClipboard(
  text: string,
  writer: ClipboardWriter | undefined,
): Promise<boolean> {
  try {
    if (!writer) return false;
    await writer(text);
    return true;
  } catch {
    return false;
  }
}
