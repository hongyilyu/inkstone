// Key-level readers for UNVALIDATED wire payloads (ADR-0014): a proposed-mutation
// or intent-graph payload crosses the UI boundary as raw `JsonValue` — possibly
// null, missing keys, or wrong-typed raw model output. Each reader coerces one key
// off a JSON object to a concrete type, degrading anything unexpected to a safe
// default rather than throwing (Core still owns accept-time validation). Built on
// the value-level `as*` readers this module re-exports from `@inkstone/protocol`,
// so `@/lib/readPayload` stays the one web-side entry point for both — the single
// source for `entityCodec`, `entityFields`, `proposalEdit`, `intentGraphReview`,
// the route search validators, and the ProposalCard.

import {
	asArray,
	asObject,
	asString,
	asStringArray,
	type JsonObject,
	type JsonValue,
} from "@inkstone/protocol";

export {
	asArray,
	asNumber,
	asObject,
	asString,
	asStringArray,
} from "@inkstone/protocol";

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
