// Proposal payloads cross the UI boundary as `unknown`. Malformed payloads should
// degrade in the review card instead of asserting a typed shape while Core still
// owns accept-time validation.
//
// `textField`/`objectField` are the ProposalCard-facing names for the shared
// `readString`/`readObject` defensive readers (lib/readPayload) — re-exported here
// so the card's call sites keep their local vocabulary while there is ONE
// implementation. `arrayField` stays local: it returns the raw `unknown[]`
// (callers filter per-field), a deliberately DIFFERENT contract from
// `readStringArray`'s pre-filtered `string[]`.

export {
	readObject as objectField,
	readString as textField,
} from "@/lib/readPayload";

export function arrayField(payload: unknown, key: string): unknown[] {
	if (payload && typeof payload === "object" && key in payload) {
		const value = (payload as Record<string, unknown>)[key];
		if (Array.isArray(value)) return value;
	}
	return [];
}
