import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DECLINED_TEXT,
	acceptedReference,
	acceptedVerb,
	decisionOutcome,
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
}

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
