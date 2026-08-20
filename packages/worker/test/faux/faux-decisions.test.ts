import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	acceptedReference,
	acceptedVerb,
	DECLINED_TEXT,
	decisionOutcome,
	tickTickWriteOutcome,
} from "../../src/faux/faux-decisions.js";

// The Decision-prose contract pin (finding F12). Core renders a decided
// Proposal's tool_result as human-readable prose (`crates/core/src/entities.rs`
// / `observations.rs` render_accept, `decide.rs` DECLINED_CONTENT), and the
// faux worker machine-parses that prose to reconstruct its phase across
// resumes. The `decision_prose.json` fixture is emitted through Core's REAL
// renderers (protocol.rs parity_fixtures), so a Rust copy edit regenerates the
// fixture and this suite reds with the changed literal — before any Playwright
// spec can fail with a "faux took the wrong phase" timeout.
interface AcceptedExample {
	verb: string;
	kind: string;
	sample: string;
}
interface DecisionProse {
	declined_text: string;
	accepted_prefix: string;
	accepted_examples: AcceptedExample[];
	ticktick_write_outcomes: Array<{
		outcome: "created" | "failed" | "unknown";
		sample: string;
	}>;
}

// the fixture is Core's committed decision-prose dump, regenerated and
// diff-gated in CI; the assertions below read exactly the fields this type names.
const fixture: DecisionProse = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../../../../tests/contract/fixtures/structs/emitted/decision_prose.json",
				import.meta.url,
			),
		),
		"utf8",
	),
) as DecisionProse;

describe("decision-prose contract (faux-decisions ↔ Core renderers)", () => {
	it("declined sentinel matches Core's DECLINED_CONTENT", () => {
		expect(DECLINED_TEXT).toBe(fixture.declined_text);
	});

	it("the declined sentinel classifies as declined", () => {
		expect(decisionOutcome(fixture.declined_text)).toBe("declined");
	});

	it("every Core accept sample classifies as accepted", () => {
		for (const ex of fixture.accepted_examples) {
			expect(decisionOutcome(ex.sample), ex.sample).toBe("accepted");
		}
	});

	// The TickTick write family (ticktick-writes W-A3): the faux worker relays
	// the outcome across the resume, so its matcher must classify each of
	// Core's three REAL texts — and must not fire on any other Decision prose.
	it("every TickTick write outcome text classifies as itself", () => {
		expect(fixture.ticktick_write_outcomes).toHaveLength(3);
		for (const { outcome, sample } of fixture.ticktick_write_outcomes) {
			expect(tickTickWriteOutcome(sample), sample).toBe(outcome);
			// None of the three is a DECLINE — all three are accepted Decisions
			// whose outcome is content the model relays (`is_error: false`).
			expect(decisionOutcome(sample), sample).not.toBe("declined");
		}
	});

	// Prose shape worth pinning: only the CREATED text wears the strict
	// "Accepted." prefix; failed/unknown read "Accepted, but …", so the shared
	// prefix classifier does not claim them. That is why the faux confirmation
	// consults `tickTickWriteOutcome` BEFORE falling through to the verb
	// matchers — a reordering there would silently report a failed write as
	// "Done." A change to either Core text reds this pin.
	it("only the created write text matches the shared accepted prefix", () => {
		const byOutcome = new Map(
			fixture.ticktick_write_outcomes.map((o) => [o.outcome, o.sample]),
		);
		expect(decisionOutcome(byOutcome.get("created") ?? "")).toBe("accepted");
		expect(decisionOutcome(byOutcome.get("failed") ?? "")).toBeUndefined();
		expect(decisionOutcome(byOutcome.get("unknown") ?? "")).toBeUndefined();
		for (const { sample } of fixture.ticktick_write_outcomes) {
			expect(sample.startsWith("Accepted"), sample).toBe(true);
		}
	});

	it("the write matcher ignores non-write Decision prose", () => {
		expect(tickTickWriteOutcome(fixture.declined_text)).toBeUndefined();
		for (const ex of fixture.accepted_examples) {
			expect(tickTickWriteOutcome(ex.sample), ex.sample).toBeUndefined();
		}
	});

	it("every Core accept sample matches its verb/kind matcher", () => {
		for (const ex of fixture.accepted_examples) {
			if (ex.kind === "Entity" && ex.verb === "Referenced") {
				expect(acceptedReference(ex.sample), ex.sample).toBe(true);
			} else if (
				ex.verb === "Created" ||
				ex.verb === "Updated" ||
				ex.verb === "Deleted"
			) {
				expect(acceptedVerb(ex.sample, ex.verb, ex.kind), ex.sample).toBe(true);
			} else {
				// Recorded (the observations accept) has no dedicated faux
				// matcher; the shared-prefix classification above is its pin.
				// A NEW verb landing here must be triaged into a branch — this
				// assert keeps the walk exhaustive instead of silently skipping.
				expect(
					ex.verb,
					`unmatched verb "${ex.verb}" — add its matcher pin`,
				).toBe("Recorded");
			}
		}
	});

	it("an ordinary tool result is not a Decision", () => {
		expect(decisionOutcome("no hits found")).toBeUndefined();
	});
});
