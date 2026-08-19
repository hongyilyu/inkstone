// The JSON contract every un-decoded wire value shares. A proposed-mutation
// payload (ADR-0014), a stored Entity's opaque `data` blob (ADR-0031) and a tool
// call's arguments all reach a consumer as parsed JSON — never as an arbitrary
// JavaScript value — so `JsonValue` is their honest static type. It sits one rung
// above `unknown`: still un-decoded (the owner's domain schema decodes it), but a
// reader can walk it without asserting, and a dictionary of it states a real
// value contract instead of an escape hatch.

import { Schema as S } from "effect";

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
