// Shared types for Inkstone's capture eval harness.
//
// The Worker drives an LLM that emits a structured proposal: an
// `apply_intent_graph` graph of entities+links, a `record_observations` batch, a
// single-entity `create_*`, or nothing. The scorer (`score.ts`) compares a
// PREDICTED proposal against an EXPECTED one and reports precision/recall/F1.
// These types are the contract between the fixture loader (later slices) and the
// scorer; this slice only needs the scorer, but `ExistingEntity` is defined now
// because slice 2 feeds the "world" the model searched against.

/** An entity the fixture's "world" already contains (what `search_entities`
 * would return). Slice 2 consumes this; defined here so the type surface is
 * stable. */
export interface ExistingEntity {
	type: "person" | "project" | "todo" | "media" | "habit";
	id: string;
	name: string;
}

/** What the model is expected to produce for a fixture. `none` means the right
 * answer is to propose nothing. `create_media` is intentionally absent: the Media
 * mutation kinds are `NotProposable` (ADR-0059), so the agent cannot emit a
 * `create_media` proposal — it is not a valid expected kind, and a predicted
 * `create_media` falls through the scorer's unknown-kind gate as a failure. */
export type ExpectedKind =
	| "apply_intent_graph"
	| "record_observations"
	| "create_todo"
	| "create_person"
	| "create_project"
	| "create_journal_entry"
	| "none";

/** The expected proposal for a fixture. Only the fields relevant to `kind` are
 * populated — `apply_intent_graph` uses `entities`/`links`, `record_observations`
 * uses `observations`, single-entity `create_*` uses `fields`. */
export interface ExpectedProposal {
	kind: ExpectedKind;
	/** For `apply_intent_graph`: the entity nodes (person/project/todo/...), each
	 * with its fields. */
	entities?: Array<
		Record<string, unknown> & { type: string; name?: string; title?: string }
	>;
	/** For `record_observations`: the observation rows, each with `schema_key` +
	 * values. */
	observations?: Array<Record<string, unknown> & { schema_key: string }>;
	/** For `apply_intent_graph`: the links (todo_project / todo_person /
	 * journal_ref). */
	links?: Array<Record<string, unknown> & { kind: string }>;
	/** For single-entity `create_*`: the entity fields directly. */
	fields?: Record<string, unknown>;
}

/** The captured raw payload the model proposed (`mutation_kind` + `payload`), or
 * `null` = proposed nothing. */
export interface PredictedProposal {
	mutation_kind: string;
	payload: unknown;
}

/** The scorer's verdict for one predicted↔expected pair. F1 values are 0..1. */
export interface ScoreResult {
	/** Did the predicted payload decode against its `@inkstone/protocol` schema? */
	schemaValid: boolean;
	/** Did predicted `mutation_kind` match `expected.kind`? */
	kindMatch: boolean;
	/** F1 over the entity record pool (apply_intent_graph nodes / single create). */
	entityF1: number;
	/** F1 over the observation record pool (record_observations). */
	obsF1: number;
	/** Micro-F1 (accuracy over matched fields) — see `score.ts`. */
	fieldF1: number;
	detail: {
		entities: {
			precision: number;
			recall: number;
			matched: number;
			predicted: number;
			expected: number;
		};
		observations: {
			precision: number;
			recall: number;
			matched: number;
			predicted: number;
			expected: number;
		};
		fields: { correct: number; total: number };
		/** Why the score is what it is, when it isn't a clean alignment — e.g.
		 * "invalid", "kind_mismatch", "none_expected_but_proposed", "missed". */
		reason?: string;
	};
}
