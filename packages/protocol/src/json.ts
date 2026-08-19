// The strict JSON contract shared by un-decoded wire values. `decodeJson` is the
// one boundary from a foreign JavaScript value; the `as*` readers then inspect an
// already-validated value without recursively decoding it again.

import { Schema as S } from "effect";

/** A JSON object keyed by wire field name. Absence is represented by a missing key. */
export type JsonObject = { [key: string]: JsonValue };

/** One JSON value: a primitive, `null`, an array, or a {@link JsonObject}. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| JsonObject;

interface TraversalFrame {
	readonly value: unknown;
	readonly leaving: boolean;
}

/** A cycle-safe identity schema for finite JSON trees. */
export const JsonValue: S.Schema<JsonValue> = S.declare<JsonValue>(
	(input): input is JsonValue => {
		const pending: TraversalFrame[] = [{ value: input, leaving: false }];
		const ancestors = new Set<object>();

		while (pending.length > 0) {
			const frame = pending.pop();
			if (frame === undefined) continue;
			const value = frame.value;

			if (frame.leaving) {
				if (typeof value === "object" && value !== null)
					ancestors.delete(value);
				continue;
			}
			if (
				value === null ||
				typeof value === "string" ||
				typeof value === "boolean"
			) {
				continue;
			}
			if (typeof value === "number") {
				if (!Number.isFinite(value)) return false;
				continue;
			}
			if (typeof value !== "object") return false;

			const array = Array.isArray(value);
			if (!array) {
				const prototype = Object.getPrototypeOf(value);
				if (prototype !== null && prototype !== Object.prototype) return false;
			}
			if (
				Object.getOwnPropertySymbols(value).length > 0 ||
				ancestors.has(value)
			) {
				return false;
			}

			ancestors.add(value);
			pending.push({ value, leaving: true });
			for (const child of array ? value : Object.values(value)) {
				pending.push({ value: child, leaving: false });
			}
		}

		return true;
	},
	{ identifier: "JsonValue", jsonSchema: {} },
);

const isJsonValue = S.is(JsonValue);

function isJsonArray(
	value: JsonValue | undefined,
): value is readonly JsonValue[] {
	return Array.isArray(value);
}

/** A strict JSON object schema: arrays, class instances and non-JSON children fail. */
export const JsonObject: S.Schema<JsonObject> = S.declare<JsonObject>(
	(input): input is JsonObject =>
		isJsonValue(input) &&
		typeof input === "object" &&
		input !== null &&
		!Array.isArray(input),
	{ identifier: "JsonObject", jsonSchema: { type: "object" } },
);

/** Decode a foreign JavaScript value to strict JSON. Invalid or cyclic values are `None`. */
export const decodeJson = S.decodeUnknownOption(JsonValue);

/** `value` as a plain JSON object, else null. */
export function asObject(value: JsonValue | undefined): JsonObject | null {
	if (value === undefined || value === null || typeof value !== "object") {
		return null;
	}
	if (isJsonArray(value)) return null;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype ? value : null;
}

/** `value` as a string, else undefined. */
export function asString(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** `value` as a finite number, else undefined. */
export function asNumber(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** `value` as a JSON array, else []. */
export function asArray(value: JsonValue | undefined): readonly JsonValue[] {
	return isJsonArray(value) ? value : [];
}

/** `value` as a `string[]`, dropping non-string entries; [] when not an array. */
export function asStringArray(value: JsonValue | undefined): string[] {
	return asArray(value).filter(
		(entry): entry is string => typeof entry === "string",
	);
}
