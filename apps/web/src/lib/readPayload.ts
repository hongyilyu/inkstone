// Defensive readers for UNVALIDATED wire payloads (ADR-0014): a proposed-mutation
// or intent-graph payload crosses the UI boundary as raw `JsonValue` — possibly
// null, missing keys, or wrong-typed raw model output. Each reader decodes one
// value (or one key off a JSON object) to a concrete type, degrading anything
// unexpected to a safe default rather than throwing (Core still owns accept-time
// validation). The single source for `entityCodec`, `entityFields`, `proposalEdit`,
// `intentGraphReview`, and the ProposalCard.

import { JsonObject, type JsonValue } from "@inkstone/protocol";
import { Option, Schema as S } from "effect";

const decodeObject = S.decodeUnknownOption(JsonObject);
const decodeString = S.decodeUnknownOption(S.String);
const decodeNumber = S.decodeUnknownOption(S.Number);

/** `value` as a JSON object, else null. Arrays degrade too: a `JsonObject` decode
 * rejects a top-level array, so an array payload defaults instead of surfacing
 * index keys. */
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
 * DIFFERENT contract from `asStringArray`'s pre-filtered `string[]`. */
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

/** Read `key` off `source` as a string, degrading anything else to "". */
export function readString(source: JsonValue | undefined, key: string): string {
	return asString(asObject(source)?.[key]) ?? "";
}

/** Read `key` off `source` as a plain object, degrading anything else to null. */
export function readObject(
	source: JsonValue | undefined,
	key: string,
): JsonObject | null {
	return asObject(asObject(source)?.[key]);
}

/** Read `key` off `source` as a JSON array (callers read per-field); [] otherwise. */
export function readArray(
	source: JsonValue | undefined,
	key: string,
): readonly JsonValue[] {
	return asArray(asObject(source)?.[key]);
}

/** Read `key` off `source` as a `string[]`, dropping non-string entries; [] otherwise. */
export function readStringArray(
	source: JsonValue | undefined,
	key: string,
): string[] {
	return asStringArray(asObject(source)?.[key]);
}
