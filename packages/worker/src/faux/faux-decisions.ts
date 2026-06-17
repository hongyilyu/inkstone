// TEST-ONLY — Core Decision-prose matchers shared across faux-worker modes.
//
// When a Proposal is decided, Core writes the outcome back into the resume
// transcript as a tool_result on the proposal's tool call: an acceptance reads
// `Accepted. <Verb> <Kind> (…details…).` and a rejection reads the exact
// sentinel `User declined this proposal.` (see crates/core resume rendering).
// The faux modes reconstruct their phase by reading that prose, which used to be
// re-spelled (startsWith / === / includes) at every site. Centralize the literal
// here so the prose contract lives in one place.

/** The exact tool_result content Core writes when the user rejects a Proposal. */
export const DECLINED_TEXT = "User declined this proposal.";

/** The prefix every accepted-Decision tool_result starts with. */
const ACCEPTED_PREFIX = "Accepted.";

/** Classify a tool_result's content as a Proposal Decision, or `undefined` when
 * it is not a Decision result at all (an ordinary tool result). */
export function decisionOutcome(
	content: string,
): "accepted" | "declined" | undefined {
	if (content.startsWith(ACCEPTED_PREFIX)) return "accepted";
	if (content === DECLINED_TEXT) return "declined";
	return undefined;
}

/** Whether `content` is an acceptance of a `<Verb> <Kind>` mutation. Core
 * renders an accepted Decision as `Accepted. <Verb> <Kind> (…details…).`, so
 * `acceptedVerb(text, "Updated", "Journal Entry")` matches
 * `Accepted. Updated Journal Entry (…).`. */
export function acceptedVerb(
	content: string,
	verb: "Created" | "Updated" | "Deleted",
	kind: string,
): boolean {
	return content.includes(`${ACCEPTED_PREFIX} ${verb} ${kind}`);
}

/** Whether `content` is an acceptance of a `Created <Kind>` mutation (e.g.
 * `acceptedCreate(text, "Todo")` matches `Accepted. Created Todo (…).`). */
export function acceptedCreate(content: string, kind: string): boolean {
	return acceptedVerb(content, "Created", kind);
}

/** Whether `content` is an acceptance of a `reference_existing_entity_*`
 * mutation (Core renders it as `Accepted. Referenced Entity (…).`). */
export function acceptedReference(content: string): boolean {
	return content.includes(`${ACCEPTED_PREFIX} Referenced Entity`);
}
