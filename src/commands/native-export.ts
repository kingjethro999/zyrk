/**
 * Validated Linux ELF64 N-API copy recipe (§12.3.1).
 *
 * Only position-independent addons with no external dynamic-library imports,
 * loader search paths or text relocations qualify. Undefined symbols are Node's
 * tested integer/property entry points and the weak ELF toolchain hooks below.
 * This recipe
 * copies bytes unchanged; it never executes package code or rewrites binaries.
 * The caller checks the exact build profile and scans host paths/credentials.
 * Other native formats and dependency recipes require dedicated adapters.
 */
import { ZyrkError } from "../errors.ts";
export function validateNativeExport(bytes: Buffer): void {
  const fail = (): never => {
    throw new ZyrkError(
      "ZYRK_DEPLOY_NONRELOCATABLE",
      "Native artifact is outside the supported Linux ELF64 N-API export recipe.",
      {
        remedy:
          "Use a position-independent N-API addon without external dynamic libraries or loader paths, or supply a validated target rebuild adapter.",
      },
    );
  };
  const range = (offset: number, size: number): void => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > bytes.length
    )
      fail();
  };
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    bytes.length < 64 ||
    bytes.length > 64 * 1024 * 1024 ||
    bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1
  )
    fail();
  if (
    bytes.readUInt16LE(16) !== 3 ||
    bytes.readUInt16LE(18) !== 62 ||
    bytes.readUInt16LE(52) !== 64 ||
    bytes.readUInt32LE(20) !== 1
  )
    fail();
  const programs = Number(bytes.readBigUInt64LE(32)),
    programSize = bytes.readUInt16LE(54),
    programCount = bytes.readUInt16LE(56);
  if (programSize !== 56 || programCount === 0 || programCount > 1024) fail();
  range(programs, programSize * programCount);
  type Region = { offset: number; size: number; address: number };
  let loaderDynamic: Region | undefined;
  const segments: Region[] = [];
  for (let i = 0; i < programCount; i++) {
    const p = programs + i * programSize,
      type = bytes.readUInt32LE(p),
      offset = Number(bytes.readBigUInt64LE(p + 8)),
      fileSize = Number(bytes.readBigUInt64LE(p + 32)),
      memorySize = Number(bytes.readBigUInt64LE(p + 40)),
      address = Number(bytes.readBigUInt64LE(p + 16));
    if (
      !Number.isSafeInteger(address) ||
      !Number.isSafeInteger(memorySize) ||
      fileSize > memorySize
    )
      fail();
    range(offset, fileSize);
    if (type === 3) fail();
    if (type === 1) segments.push({ offset, size: fileSize, address });
    if (type === 2) {
      if (loaderDynamic) fail();
      if (fileSize !== memorySize) fail();
      loaderDynamic = { offset, size: fileSize, address };
    }
  }
  const table = Number(bytes.readBigUInt64LE(40)),
    size = bytes.readUInt16LE(58),
    count = bytes.readUInt16LE(60);
  if (size !== 64 || count === 0 || count > 4096) fail();
  range(table, size * count);
  const section = (index: number) => {
    if (index < 0 || index >= count) fail();
    const p = table + index * size;
    return {
      type: bytes.readUInt32LE(p + 4),
      address: Number(bytes.readBigUInt64LE(p + 16)),
      offset: Number(bytes.readBigUInt64LE(p + 24)),
      size: Number(bytes.readBigUInt64LE(p + 32)),
      link: bytes.readUInt32LE(p + 40),
      entry: Number(bytes.readBigUInt64LE(p + 56)),
    };
  };
  const mapped = (region: Region): void => {
    if (
      !segments.some(
        (segment) =>
          region.offset >= segment.offset &&
          region.offset + region.size <= segment.offset + segment.size &&
          region.address === segment.address + region.offset - segment.offset,
      )
    )
      fail();
  };
  const tags = new Map<bigint, bigint>();
  let symbols: ReturnType<typeof section> | undefined,
    strings: ReturnType<typeof section> | undefined;
  let registration = false,
    api = false,
    dynamic = false;
  const validatedApi = new Set([
    "napi_create_int32",
    "napi_set_named_property",
  ]);
  const weakHooks = new Set([
    "__cxa_finalize",
    "__gmon_start__",
    "_ITM_registerTMCloneTable",
    "_ITM_deregisterTMCloneTable",
  ]);
  for (let i = 0; i < count; i++) {
    const s = section(i);
    if (s.type !== 6 && s.type !== 11) continue;
    range(s.offset, s.size);
    if (s.type === 6) {
      if (
        dynamic ||
        !loaderDynamic ||
        loaderDynamic.offset !== s.offset ||
        loaderDynamic.size !== s.size ||
        loaderDynamic.address !== s.address
      )
        fail();
      mapped(s);
      dynamic = true;
      if (s.entry !== 16 || s.size % 16 !== 0) fail();
      let terminated = false;
      for (let p = s.offset; p < s.offset + s.size; p += 16) {
        const tag = bytes.readBigInt64LE(p),
          value = bytes.readBigUInt64LE(p + 8);
        if (tag === 0n) {
          terminated = true;
          break;
        }
        if ([5n, 6n, 10n, 11n].includes(tag) && tags.has(tag)) fail();
        tags.set(tag, value);
        if (
          [
            1n,
            15n,
            22n,
            29n,
            0x7fffffffn,
            0x7ffffffdn,
            0x6ffffefbn,
            0x6ffffefcn,
          ].includes(tag) ||
          (tag === 30n && (value & 4n) !== 0n)
        )
          fail();
      }
      if (!terminated) fail();
    } else {
      if (symbols) fail();
      symbols = s;
      mapped(s);
      if (s.entry !== 24 || s.size % 24 !== 0) fail();
      const names = section(s.link);
      strings = names;
      mapped(names);
      if (names.type !== 3) fail();
      range(names.offset, names.size);
      for (let p = s.offset; p < s.offset + s.size; p += 24) {
        const nameOffset = bytes.readUInt32LE(p),
          info = bytes[p + 4]!,
          index = bytes.readUInt16LE(p + 6);
        if (nameOffset >= names.size) fail();
        const start = names.offset + nameOffset,
          end = bytes.indexOf(0, start);
        if (end < start || end >= names.offset + names.size) fail();
        const name = bytes.subarray(start, end).toString("utf8");
        if (index === 0 && name) {
          if (validatedApi.has(name)) api = true;
          else if (!(info >> 4 === 2 && weakHooks.has(name))) fail();
        }
        if (
          name === "napi_register_module_v1" &&
          index !== 0 &&
          (info & 15) === 2
        )
          registration = true;
      }
    }
  }
  if (!dynamic || !registration || !api || !symbols || !strings) return fail();
  if (
    tags.get(6n) !== BigInt(symbols.address) ||
    tags.get(11n) !== 24n ||
    tags.get(5n) !== BigInt(strings.address) ||
    tags.get(10n) !== BigInt(strings.size)
  )
    fail();
  // The dependency-free recipe has no legitimate external filesystem prerequisite.
  // Reject literal absolute path strings; encoded paths require another adapter.
  for (const text of bytes.toString("latin1").split("\0")) {
    if (
      /^[\x20-\x7e]{4,}$/.test(text) &&
      /(?:^|[\s"'=])(?:\/[A-Za-z0-9_.~-]|[A-Za-z]:[\\/])/.test(text)
    )
      fail();
  }
}
