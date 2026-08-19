// The JSON contract every un-decoded wire value shares, plus the lenient readers
// that walk one. A proposed-mutation payload (ADR-0014), a stored Entity's opaque
// `data` blob (ADR-0031) and a tool call's arguments all reach a consumer as parsed
// JSON — never as an arbitrary JavaScript value — so `JsonValue` is their honest
// static type. It sits one rung above `unknown`: still un-decoded (the owner's
// domain schema decodes it), but a reader can walk it without asserting, and a
// dictionary of it states a real value contract instead of an escape hatch.
//
// The `as*` readers are the shared degrade-don't-throw half of that: each decodes
// one value to a concrete type and returns the miss (null / undefined / []) rather
// than failing, for the boundaries where the payload is raw model or legacy output
// the UI must still render (Core owns accept-time validation).

import { Option, Schema as S } from "effect";

/** A JSON object keyed by wire field name. A missing key and an `undefined` value
 * mean the same absence (`JSON.stringify` drops the key) — which is what lets a
 * full-document-replace builder clear a field in place (omit ≡ null, ADR-0033). */
export type JsonObject = { [key: string]: JsonValue | undefined };

/** One JSON value: a primitive, `null`, an array, or a {@link JsonObject}. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| JsonObject;

/** The Schema mirror of {@link JsonValue}, recursive via `S.suspend`. */
export const JsonValue: S.Schema<JsonValue> = S.suspend(() =>
	S.Union(
		S.String,
		S.Number,
		S.Boolean,
		S.Null,
		S.Array(JsonValue),
		JsonObject,
	),
);

/** The Schema mirror of {@link JsonObject}: decodes a plain object ONLY (a
 * top-level array, primitive or `null` fails) and keeps every key, unlike an
 * `S.Struct` decode. The narrowing a reader needs to index a {@link JsonValue}. */
export const JsonObject: S.Schema<JsonObject> = S.Record({
	key: S.String,
	value: S.UndefinedOr(JsonValue),
});

/** Decode what a foreign SDK hands over as its own open type (`unknown`,
 * `{[x: string]: unknown}` spanning protocol revisions) to the wire truth. `None`
 * when the value is not JSON; call sites degrade that to `null`. The one crossing
 * from a library's escape hatch into {@link JsonValue}. */
export const decodeJson = S.decodeUnknownOption(JsonValue);

const decodeObject = S.decodeUnknownOption(JsonObject);
const decodeString = S.decodeUnknownOption(S.String);
const decodeNumber = S.decodeUnknownOption(S.Number);

/** `value` as a JSON object, else null. Arrays degrade too: a {@link JsonObject}
 * decode rejects a top-level array, so an array never surfaces index keys. */
export function asObject(value: JsonValue | undefined): JsonObject | null {
	return Option.getOrNull(decodeObject(value));
}

/** `value` as a string, else undefined. */
export function asString(value: JsonValue | undefined): string | undefined {
	return Option.getOrUndefined(decodeString(value));
}

/** `value` as a number, else undefined. */
export function asNumber(value: JsonValue | undefined): number | undefined {
	return Option.getOrUndefined(decodeNumber(value));
}

/** `value` as a JSON array, else []. Entries stay un-decoded — a deliberately
 * DIFFERENT contract from {@link asStringArray}'s pre-filtered `string[]`. */
export function asArray(value: JsonValue | undefined): readonly JsonValue[] {
	return Array.isArray(value) ? value : [];
}

/** `value` as a `string[]`, dropping non-string entries; [] when not an array. */
export function asStringArray(value: JsonValue | undefined): string[] {
	return asArray(value).flatMap((entry) => {
		const text = asString(entry);
		return text === undefined ? [] : [text];
	});
}
