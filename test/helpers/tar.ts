/**
 * Minimal ustar writer for tests.
 *
 * Tests must be able to craft archives the `tar` package itself would never
 * produce (traversal names, absolute symlink targets, case collisions, hard
 * links), so we write the 512-byte headers directly. This is test-only code:
 * nothing in src/ parses these bytes.
 */
import { gzipSync } from "node:zlib";

const BLOCK = 512;

export type CraftEntry =
  | { path: string; type?: "file"; data?: string | Buffer; mode?: number }
  | { path: string; type: "dir"; mode?: number }
  | { path: string; type: "symlink"; link: string; mode?: number }
  | { path: string; type: "hardlink"; link: string; mode?: number };

function oct(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function put(buf: Buffer, offset: number, value: string, length: number): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`tar field too long (${bytes.length} > ${length}): ${value}`);
  }
  bytes.copy(buf, offset);
}

function header(entry: CraftEntry): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  let nameField = entry.path;
  let prefix = "";
  if (Buffer.byteLength(nameField, "utf8") > 100) {
    let split = -1;
    for (let i = nameField.length - 1; i > 0; i -= 1) {
      if (nameField[i] !== "/") continue;
      if (
        Buffer.byteLength(nameField.slice(0, i), "utf8") <= 155 &&
        Buffer.byteLength(nameField.slice(i + 1), "utf8") <= 100
      ) {
        split = i;
        break;
      }
    }
    if (split === -1) throw new Error(`cannot encode tar path: ${entry.path}`);
    prefix = nameField.slice(0, split);
    nameField = nameField.slice(split + 1);
  }

  const kind = entry.type ?? "file";
  let data = Buffer.alloc(0);
  let link = "";
  switch (entry.type) {
    case undefined:
    case "file":
      data = Buffer.from(entry.data ?? "");
      break;
    case "dir":
      break;
    case "symlink":
    case "hardlink":
      link = entry.link;
      break;
  }
  const mode = entry.mode ?? (kind === "dir" ? 0o755 : 0o644);

  put(buf, 0, nameField, 100);
  put(buf, 100, oct(mode & 0o7777, 8), 8);
  put(buf, 108, oct(0, 8), 8); // uid
  put(buf, 116, oct(0, 8), 8); // gid
  put(buf, 124, oct(data.length, 12), 12);
  put(buf, 136, oct(0, 12), 12); // mtime
  buf.fill(0x20, 148, 156); // checksum placeholder
  const typeflag = kind === "dir" ? "5" : kind === "symlink" ? "2" : kind === "hardlink" ? "1" : "0";
  put(buf, 156, typeflag, 1);
  if (link !== "") put(buf, 157, link, 100);
  put(buf, 257, "ustar\0", 6);
  put(buf, 263, "00", 2);
  if (prefix !== "") put(buf, 345, prefix, 155);

  let sum = 0;
  for (const byte of buf) sum += byte;
  put(buf, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return buf;
}

export function craftTar(entries: CraftEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry));
    let data = Buffer.alloc(0);
    if (entry.type === undefined || entry.type === "file") {
      data = Buffer.from(entry.data ?? "");
    }
    if (data.length > 0) {
      parts.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad > 0) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export function craftTarGz(entries: CraftEntry[]): Buffer {
  return gzipSync(craftTar(entries));
}
