import { describe, expect, it } from "vitest";
import { readObject, readString, readStringArray } from "@/lib/readPayload";

// These pin the defensive-read contract directly (independent of each consumer's
// tests): the payload is UNVALIDATED wire input (ADR-0014), so every reader must
// degrade a null / non-object / missing-key / wrong-typed source to its safe
// default rather than throw.

describe("readString", () => {
	it("returns the string value for a present string key", () => {
		expect(readString({ name: "Alice" }, "name")).toBe("Alice");
	});

	it("preserves an empty-string value verbatim", () => {
		expect(readString({ name: "" }, "name")).toBe("");
	});

	it('degrades a missing key to ""', () => {
		expect(readString({ other: "x" }, "name")).toBe("");
	});

	it('degrades a non-string value to ""', () => {
		expect(readString({ name: 42 }, "name")).toBe("");
		expect(readString({ name: null }, "name")).toBe("");
		expect(readString({ name: { nested: 1 } }, "name")).toBe("");
	});

	it('degrades a null / non-object / array source to ""', () => {
		expect(readString(null, "name")).toBe("");
		expect(readString(undefined, "name")).toBe("");
		expect(readString("a string", "name")).toBe("");
		expect(readString(["name"], "name")).toBe("");
	});
});

describe("readObject", () => {
	it("returns the plain-object value for a present object key", () => {
		const inner = { title: "T" };
		expect(readObject({ todo: inner }, "todo")).toEqual(inner);
	});

	it("degrades a missing key to null", () => {
		expect(readObject({ other: {} }, "todo")).toBeNull();
	});

	it("degrades a non-object value to null", () => {
		expect(readObject({ todo: "x" }, "todo")).toBeNull();
		expect(readObject({ todo: 1 }, "todo")).toBeNull();
		expect(readObject({ todo: null }, "todo")).toBeNull();
	});

	it("rejects an array value (arrays are not plain objects here) → null", () => {
		expect(readObject({ todo: [1, 2] }, "todo")).toBeNull();
	});

	it("degrades a null / non-object / array source to null", () => {
		expect(readObject(null, "todo")).toBeNull();
		expect(readObject(undefined, "todo")).toBeNull();
		expect(readObject(42, "todo")).toBeNull();
		expect(readObject([{ todo: {} }], "todo")).toBeNull();
	});
});

describe("readStringArray", () => {
	it("returns the string array for a present array key", () => {
		expect(readStringArray({ aliases: ["a", "b"] }, "aliases")).toEqual([
			"a",
			"b",
		]);
	});

	it("filters out non-string entries, keeping order of the survivors", () => {
		expect(
			readStringArray({ aliases: ["a", 1, null, "b", {}, "c"] }, "aliases"),
		).toEqual(["a", "b", "c"]);
	});

	it("degrades a missing key to []", () => {
		expect(readStringArray({ other: ["a"] }, "aliases")).toEqual([]);
	});

	it("degrades a non-array value to []", () => {
		expect(readStringArray({ aliases: "a,b" }, "aliases")).toEqual([]);
		expect(readStringArray({ aliases: null }, "aliases")).toEqual([]);
		expect(readStringArray({ aliases: { 0: "a" } }, "aliases")).toEqual([]);
	});

	it("degrades a null / non-object / array source to []", () => {
		expect(readStringArray(null, "aliases")).toEqual([]);
		expect(readStringArray(undefined, "aliases")).toEqual([]);
		expect(readStringArray(["aliases"], "aliases")).toEqual([]);
	});
});
