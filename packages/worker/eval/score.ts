// The eval scorer: compares a PREDICTED proposal against an EXPECTED one and
// reports precision/recall/F1 over entity and observation record pools, plus a
// field micro-F1 over matched pairs. Pure function, no I/O — later slices feed
// it real model output. The schema gate decodes the predicted payload against
// the matching `@inkstone/protocol` schema; an invalid payload scores zero.

import { schemas } from "@inkstone/protocol";
import { Either, Schema as S } from "effect";
import type {
	ExpectedKind,
	ExpectedProposal,
	PredictedProposal,
	ScoreResult,
} from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Canonical string form for comparison: trim, lowercase, collapse whitespace. */
export function normalize(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The "base" name of a project, for the Lead-Ads dedup rule: the model
 * sometimes tacks a trailing activity/aspect qualifier onto the canonical name,
 * e.g. "Lead Ads — Rodeo activity" vs the expected "Lead Ads". Heuristic: collapse
 * the predicted name to the expected name only when they are equal, or when the
 * predicted name is the expected name followed by a WORD BOUNDARY (a space) and a
 * trailing qualifier; otherwise return the predicted name as-is.
 *
 * Word-boundary prefix (not raw `startsWith`, and certainly not `includes`): a
 * bare prefix test still false-merges two distinct projects that merely share a
 * leading word fragment — "Apple Pie Project" `startsWith` "App" is true, and
 * `includes` is worse — which would inflate entityF1 to 1.0 in the dangerous
 * false-HIGH direction. Anchoring on the next-token space keeps the Lead-Ads
 * trailing-qualifier dedup ("Lead Ads — …", "Lead Ads testing") without the hole. */
export function projectBaseName(predicted: string, expected: string): string {
	const p = normalize(predicted);
	const e = normalize(expected);
	if (e.length > 0 && (p === e || p.startsWith(`${e} `))) return e;
	return p;
}

/** Harmonic mean of precision and recall; 0 when either is 0. */
export function f1(precision: number, recall: number): number {
	if (precision <= 0 || recall <= 0) return 0;
	return (2 * precision * recall) / (precision + recall);
}

// ── record pools ───────────────────────────────────────────────────────────

/** A normalized record we align on: a kind tag (entity `type` / observation
 * `schema_key`), a display name (entity name/title), and the raw fields. */
interface Record_ {
	tag: string;
	name: string | undefined;
	fields: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const asString = (v: unknown): string | undefined =>
	typeof v === "string" ? v : undefined;

/** Pull the entity record pool out of a predicted payload by kind. */
function predictedEntityPool(
	kind: string,
	payload: Record<string, unknown>,
): Record_[] {
	if (kind === "apply_intent_graph") {
		const nodes = Array.isArray(payload.entities) ? payload.entities : [];
		return nodes.filter(isRecord).map((n) => ({
			tag: asString(n.type) ?? "",
			name: asString(n.name) ?? asString(n.title),
			fields: n,
		}));
	}
	if (
		kind === "create_person" ||
		kind === "create_project" ||
		kind === "create_todo"
	) {
		// A single synthetic record from the payload's entity fields. create_todo
		// nests the fields under `todo`; the others carry them flat.
		const fields =
			kind === "create_todo" && isRecord(payload.todo) ? payload.todo : payload;
		const tag =
			kind === "create_person"
				? "person"
				: kind === "create_project"
					? "project"
					: "todo";
		return [
			{ tag, name: asString(fields.name) ?? asString(fields.title), fields },
		];
	}
	// create_journal_entry → prose, no scored entity pool. record_observations →
	// scored as observations, not entities.
	return [];
}

/** Pull the observation record pool out of a predicted payload by kind. */
function predictedObsPool(
	kind: string,
	payload: Record<string, unknown>,
): Record_[] {
	if (kind !== "record_observations") return [];
	const rows = Array.isArray(payload.observations) ? payload.observations : [];
	return rows.filter(isRecord).map((o) => ({
		tag: asString(o.schema_key) ?? "",
		name: undefined, // observations align on schema_key alone
		fields: o,
	}));
}

/** Build the expected entity pool from an ExpectedProposal. */
function expectedEntityPool(expected: ExpectedProposal): Record_[] {
	if (expected.kind === "apply_intent_graph") {
		return (expected.entities ?? []).map((e) => ({
			tag: e.type,
			name: e.name ?? e.title,
			fields: e,
		}));
	}
	if (
		expected.kind === "create_person" ||
		expected.kind === "create_project" ||
		expected.kind === "create_todo"
	) {
		const fields = expected.fields ?? {};
		const tag =
			expected.kind === "create_person"
				? "person"
				: expected.kind === "create_project"
					? "project"
					: "todo";
		return [
			{ tag, name: asString(fields.name) ?? asString(fields.title), fields },
		];
	}
	return [];
}

/** Build the expected observation pool from an ExpectedProposal. */
function expectedObsPool(expected: ExpectedProposal): Record_[] {
	if (expected.kind !== "record_observations") return [];
	return (expected.observations ?? []).map((o) => ({
		tag: o.schema_key,
		name: undefined,
		fields: o,
	}));
}

// ── alignment ──────────────────────────────────────────────────────────────

interface Alignment {
	matched: number;
	pairs: Array<{ expected: Record_; predicted: Record_ }>;
}

/** Greedily match expected↔predicted records: same tag, and (for entities) a
 * name match after normalize — with the projectBaseName relaxation for project
 * names. Each predicted record is consumed by at most one expected record. */
function align(expected: Record_[], predicted: Record_[]): Alignment {
	const used = new Array<boolean>(predicted.length).fill(false);
	const pairs: Alignment["pairs"] = [];
	for (const exp of expected) {
		for (let i = 0; i < predicted.length; i++) {
			if (used[i]) continue;
			const pred = predicted[i];
			if (pred.tag !== exp.tag) continue;
			if (!namesMatch(exp, pred)) continue;
			used[i] = true;
			pairs.push({ expected: exp, predicted: pred });
			break;
		}
	}
	return { matched: pairs.length, pairs };
}

function namesMatch(exp: Record_, pred: Record_): boolean {
	// Observations (no name) align on tag alone.
	if (exp.name === undefined && pred.name === undefined) return true;
	if (exp.name === undefined || pred.name === undefined) return false;
	if (exp.tag === "project") {
		return projectBaseName(pred.name, exp.name) === normalize(exp.name);
	}
	return normalize(pred.name) === normalize(exp.name);
}

interface PoolScore {
	precision: number;
	recall: number;
	matched: number;
	predicted: number;
	expected: number;
}

function scorePool(
	expected: Record_[],
	predicted: Record_[],
): {
	score: PoolScore;
	f1: number;
	pairs: Alignment["pairs"];
} {
	const { matched, pairs } = align(expected, predicted);
	const p = predicted.length === 0 ? 0 : matched / predicted.length;
	const r = expected.length === 0 ? 0 : matched / expected.length;
	// Both pools empty: nothing to extract, nothing extracted → perfect.
	const poolF1 = expected.length === 0 && predicted.length === 0 ? 1 : f1(p, r);
	return {
		score: {
			precision: p,
			recall: r,
			matched,
			predicted: predicted.length,
			expected: expected.length,
		},
		f1: poolF1,
		pairs,
	};
}

// ── field micro-F1 ───────────────────────────────────────────────────────────

const HANDLE_TAGS = new Set(["handle"]);

/** Compare matched record pairs field-by-field, scoring only the fields the
 * expected record specifies (extra predicted fields don't penalize). Strings are
 * compared after normalize; everything else by deep-equality. Returns the running
 * correct/total counts across all matched pairs. */
function scoreFields(
	pairs: Alignment["pairs"],
	scoredKeys: (rec: Record_) => string[],
): { correct: number; total: number } {
	let correct = 0;
	let total = 0;
	for (const { expected, predicted } of pairs) {
		for (const key of scoredKeys(expected)) {
			total += 1;
			if (fieldEquals(expected.fields[key], predicted.fields[key]))
				correct += 1;
		}
	}
	return { correct, total };
}

function fieldEquals(a: unknown, b: unknown): boolean {
	if (typeof a === "string" && typeof b === "string") {
		return normalize(a) === normalize(b);
	}
	return deepEqual(a, b);
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((x, i) => deepEqual(x, b[i]));
	}
	if (isRecord(a) && isRecord(b)) {
		const ak = Object.keys(a);
		const bk = Object.keys(b);
		if (ak.length !== bk.length) return false;
		return ak.every((k) => deepEqual(a[k], b[k]));
	}
	return false;
}

/** The expected fields scored for an entity record — everything the expected
 * specifies EXCEPT the structural keys that drove alignment (`type`/`handle`),
 * since those are not graded content. (`name`/`title` ARE graded — a matched
 * record can still have, e.g., a near-but-not-equal name worth penalizing.) */
function entityScoredKeys(rec: Record_): string[] {
	return Object.keys(rec.fields).filter(
		(k) => k !== "type" && !HANDLE_TAGS.has(k),
	);
}

/** The expected fields scored for an observation record — everything except the
 * `schema_key` that drove alignment. */
function obsScoredKeys(rec: Record_): string[] {
	return Object.keys(rec.fields).filter((k) => k !== "schema_key");
}

// ── the scorer ───────────────────────────────────────────────────────────────

const emptyPool = (): PoolScore => ({
	precision: 0,
	recall: 0,
	matched: 0,
	predicted: 0,
	expected: 0,
});

/** A perfect result (all F1 = 1, clean pools) — the `none`+`null` case. */
function perfect(): ScoreResult {
	return {
		schemaValid: true,
		kindMatch: true,
		entityF1: 1,
		obsF1: 1,
		fieldF1: 1,
		detail: {
			entities: { ...emptyPool(), precision: 1, recall: 1 },
			observations: { ...emptyPool(), precision: 1, recall: 1 },
			fields: { correct: 0, total: 0 },
		},
	};
}

function zeroed(reason: string, opts?: Partial<ScoreResult>): ScoreResult {
	return {
		schemaValid: opts?.schemaValid ?? true,
		kindMatch: opts?.kindMatch ?? false,
		entityF1: 0,
		obsF1: 0,
		fieldF1: 0,
		detail: {
			entities: emptyPool(),
			observations: emptyPool(),
			fields: { correct: 0, total: 0 },
			reason,
		},
	};
}

/** Whether `mutationKind` is one of the agent-proposable wire kinds registered in
 * `@inkstone/protocol`'s `schemas`. The scorer only accepts these — a hallucinated
 * or typo'd kind (e.g. `create_widget`, or the NotProposable `create_media`,
 * ADR-0059) is NOT here and must score as a gate failure, not sail through. */
function isRegisteredKind(
	mutationKind: string,
): mutationKind is keyof typeof schemas {
	return mutationKind in schemas;
}

/** Decode a predicted payload against its registered `@inkstone/protocol` schema.
 * Returns `true` on a clean decode. Callers gate the unregistered-kind case
 * separately (see `isRegisteredKind`); this only runs for known kinds. */
function schemaDecodes(
	mutationKind: keyof typeof schemas,
	payload: unknown,
): boolean {
	const schema = schemas[mutationKind] as S.Schema<unknown, unknown>;
	return Either.isRight(S.decodeUnknownEither(schema)(payload));
}

export function scoreProposal(
	predicted: PredictedProposal | null,
	expected: ExpectedProposal,
): ScoreResult {
	// 1. none-handling first.
	if (expected.kind === "none") {
		if (predicted === null) return perfect();
		// A hallucinated proposal: entity precision 0 (over-extraction), F1 0.
		const r = zeroed("none_expected_but_proposed", {
			schemaValid: true,
			kindMatch: false,
		});
		r.detail.entities.precision = 0;
		// recall is vacuous (nothing expected) → treat as 1, but F1 stays 0.
		r.detail.entities.recall = 1;
		return r;
	}
	if (predicted === null) {
		// expected non-none + predicted null → a miss.
		const r = zeroed("missed", { schemaValid: true, kindMatch: false });
		r.detail.entities.recall = 0;
		r.detail.observations.recall = 0;
		return r;
	}

	// 2. Schema gate. An unregistered/hallucinated kind fails outright; a
	// registered kind whose payload doesn't decode fails as "invalid".
	if (!isRegisteredKind(predicted.mutation_kind)) {
		return zeroed("unknown_kind", { schemaValid: false, kindMatch: false });
	}
	if (!schemaDecodes(predicted.mutation_kind, predicted.payload)) {
		return zeroed("invalid", { schemaValid: false, kindMatch: false });
	}

	// 3. kindMatch.
	const kindMatch = predicted.mutation_kind === (expected.kind as ExpectedKind);

	const payload = isRecord(predicted.payload) ? predicted.payload : {};

	// 4 + 5. Extract + align record pools.
	const entExpected = expectedEntityPool(expected);
	const entPredicted = predictedEntityPool(predicted.mutation_kind, payload);
	const obsExpected = expectedObsPool(expected);
	const obsPredicted = predictedObsPool(predicted.mutation_kind, payload);

	const ent = scorePool(entExpected, entPredicted);
	const obs = scorePool(obsExpected, obsPredicted);

	// 7. Field micro-F1 over matched pairs (both pools' matches contribute).
	const entFields = scoreFields(ent.pairs, entityScoredKeys);
	const obsFields = scoreFields(obs.pairs, obsScoredKeys);
	const correct = entFields.correct + obsFields.correct;
	const total = entFields.total + obsFields.total;
	const fieldF1 = total === 0 ? 1 : correct / total;

	return {
		schemaValid: true,
		kindMatch,
		entityF1: ent.f1,
		obsF1: obs.f1,
		fieldF1,
		detail: {
			entities: ent.score,
			observations: obs.score,
			fields: { correct, total },
			reason: kindMatch ? undefined : "kind_mismatch",
		},
	};
}
