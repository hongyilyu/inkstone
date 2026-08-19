import { Option, Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
	asNumber,
	asObject,
	asString,
	asStringArray,
	decodeJson,
	JsonObject,
	JsonValue,
} from "../src/index.js";

interface CircularObject {
	self?: CircularObject;
}

describe("JsonValue", () => {
	it("accepts finite JSON trees without cloning them", () => {
		const value = {
			text: "hello",
			count: 3,
			flags: [true, false, null],
			nested: { ok: true },
		};
		expect(S.decodeUnknownSync(JsonValue)(value)).toBe(value);
		expect(S.decodeUnknownSync(JsonObject)(value)).toBe(value);
	});

	it.each([
		["undefined", undefined],
		["date", new Date(0)],
		["regexp", /x/u],
		["NaN", Number.NaN],
		["positive infinity", Number.POSITIVE_INFINITY],
		["nested undefined", { value: undefined }],
		["symbol key", { [Symbol("key")]: "value" }],
	])("rejects %s", (_name, value) => {
		expect(Option.isNone(decodeJson(value))).toBe(true);
	});

	it("rejects cycles without throwing", () => {
		const circular: CircularObject = {};
		circular.self = circular;
		expect(() => decodeJson(circular)).not.toThrow();
		expect(Option.isNone(decodeJson(circular))).toBe(true);
	});

	it("allows repeated non-cyclic references", () => {
		const shared = { id: "same" };
		expect(Option.isSome(decodeJson({ left: shared, right: shared }))).toBe(
			true,
		);
	});
});

describe("JSON readers", () => {
	it("inspect validated values without recursively decoding them", () => {
		const object = { text: "hello", count: 3, values: ["a", false, "b"] };
		expect(asObject(object)).toBe(object);
		expect(asString(object.text)).toBe("hello");
		expect(asNumber(object.count)).toBe(3);
		expect(asStringArray(object.values)).toEqual(["a", "b"]);
	});

	it("degrades non-matching values", () => {
		expect(asObject([])).toBeNull();
		expect(asObject(new Date(0) as never)).toBeNull();
		expect(asString(3)).toBeUndefined();
		expect(asNumber(Number.NaN)).toBeUndefined();
	});
});
