import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/util/json.ts";

describe("canonicalJson", () => {
  it("sorts object keys regardless of insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("is stable across nested structures", () => {
    const a = { z: { b: [3, { d: 1, c: 2 }], a: null }, y: "s" };
    const b = { y: "s", z: { a: null, b: [3, { c: 2, d: 1 }] } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"y":"s","z":{"a":null,"b":[3,{"c":2,"d":1}]}}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });

  it("escapes strings like JSON.stringify", () => {
    expect(canonicalJson("a\nb\t\"c\\d")).toBe(JSON.stringify("a\nb\t\"c\\d"));
    expect(canonicalJson("héllo\u0000")).toBe(JSON.stringify("héllo\u0000"));
  });

  it("rejects values JSON cannot represent deterministically", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
  });

  it("does not emit undefined properties even when nested", () => {
    expect(() => canonicalJson({ a: { b: undefined } })).toThrow(TypeError);
  });

  it("bounds nesting depth", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 250; i += 1) deep = { next: deep };
    expect(() => canonicalJson(deep)).toThrow(TypeError);
  });
});
