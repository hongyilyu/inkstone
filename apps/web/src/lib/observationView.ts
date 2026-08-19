import type { JsonValue, ObservationRow } from "@inkstone/protocol";
import { Either, Schema as S } from "effect";

/** One displayed field row of an observation view (label + already-rendered value). */
export interface ObservationField {
	label: string;
	value: string;
}

/** The display-ready view of a single `ObservationRow`, schema-aware where we know
 * the schema and a graceful raw-JSON fallback otherwise. Pure and never throws. */
export interface ObservationItemView {
	id: string;
	schemaKey: string;
	occurredAt: string;
	endedAt: string | null;
	note: string | null;
	/** The raw `values` JSON object from the wire, carried verbatim so the
	 * correction editor can pre-fill its `values` textarea. Display projects to
	 * `summary`/`fields`, which lose the raw shape. */
	values: JsonValue;
	/** Calm one-line headline (e.g. `"72.4 kg"`, `"Habit · abcd1234"`). */
	summary: string;
	/** Per-schema detail rows for display. */
	fields: ObservationField[];
	/** Provenance from the wire (`null` when the observation has no recorded
	 * source); drives the display-only "Captured from" label. */
	source: ObservationRow["source"];
}

/** A per-`schema_key` polish strategy with its value type ERASED: decode and both
 * renderers are paired INSIDE `render`, so a registry can hold views over different
 * value types without a cast. `null` when `values` don't decode — the caller then
 * degrades to the raw-JSON fallback. */
interface ObservationView {
	render: (
		values: JsonValue,
	) => { summary: string; fields: ObservationField[] } | null;
}

/** Pair a value schema with its renderers into one {@link ObservationView}; `A` is
 * bound here and never escapes. */
function polished<A>(
	schema: S.Schema<A>,
	summary: (values: A) => string,
	fields: (values: A) => ObservationField[],
): ObservationView {
	const decode = S.decodeUnknownEither(schema);
	return {
		render: (values) => {
			const decoded = decode(values);
			return Either.isLeft(decoded)
				? null
				: { summary: summary(decoded.right), fields: fields(decoded.right) };
		},
	};
}

// Read-side value schemas mirroring protocol's private `bodyweightValues` /
// `habitCheckinValues` (those aren't exported). These are display-only: we decode
// defensively and degrade to the JSON fallback on any mismatch, so they don't need
// the wire's stricter UUID pattern — just enough shape to render a polished line.
const bodyweightValues = S.Struct({
	kg: S.Number.pipe(S.greaterThanOrEqualTo(0)),
});

const habitCheckinValues = S.Struct({
	habit_id: S.String,
	state: S.Literal("done", "skipped", "missed"),
	quantity: S.optional(S.Number),
});

/** Open map of schema-aware views, keyed by `schema_key`. An unrecognized key
 * falls through to the JSON fallback in {@link toObservationView}; a Map keys on an
 * unvalidated wire string without inheriting `Object.prototype` members. */
const OBSERVATION_VIEWS = new Map<string, ObservationView>([
	[
		"bodyweight",
		polished(
			bodyweightValues,
			(v) => `${v.kg} kg`,
			(v) => [{ label: "Weight", value: `${v.kg} kg` }],
		),
	],
	[
		"habit.checkin",
		polished(
			habitCheckinValues,
			(v) => `Habit · ${v.habit_id.slice(0, 8)}`,
			(v) => {
				const fields: ObservationField[] = [{ label: "State", value: v.state }];
				if (v.quantity !== undefined) {
					fields.push({ label: "Quantity", value: String(v.quantity) });
				}
				return fields;
			},
		),
	],
]);

/** JSON of the raw `values`, used as the graceful fallback for unknown schemas or
 * undecodable values. Mirrors `observationValueText` in ProposalCardObservations. */
function valuesJson(values: JsonValue): string {
	// Wire `values` is JSON-tree data, so `JSON.stringify` is total over it in
	// practice — but the "never throws" contract is absolute, so guard against a
	// non-wire caller passing a BigInt / circular / throwing-`toJSON` value.
	try {
		return JSON.stringify(values) ?? "null";
	} catch {
		return "[unserializable]";
	}
}

function fallbackView(row: ObservationRow): ObservationItemView {
	return {
		id: row.id,
		schemaKey: row.schema_key,
		occurredAt: row.occurred_at,
		endedAt: row.ended_at,
		note: row.note,
		values: row.values,
		summary: row.schema_key,
		fields: [{ label: "Values", value: valuesJson(row.values) }],
		source: row.source,
	};
}

/** Build a display-ready view from an `ObservationRow`. For a KNOWN `schema_key`
 * whose `values` decode, returns the polished summary + fields. For an unknown key
 * OR a known key whose `values` fail to decode, returns the raw key + JSON
 * fallback. Never throws — read-side display resilience. */
export function toObservationView(row: ObservationRow): ObservationItemView {
	const view = OBSERVATION_VIEWS.get(row.schema_key)?.render(row.values);
	if (view === undefined || view === null) return fallbackView(row);
	return {
		id: row.id,
		schemaKey: row.schema_key,
		occurredAt: row.occurred_at,
		endedAt: row.ended_at,
		note: row.note,
		values: row.values,
		summary: view.summary,
		fields: view.fields,
		source: row.source,
	};
}

export interface ObservationDay {
	day: string;
	items: ObservationItemView[];
}

/** Bucket observation views by `occurred_at` day (YYYY-MM-DD), newest day first,
 * ascending by occurred_at then id within a day. Mirrors
 * `groupJournalEntriesByDay` (libraryItems.ts). */
export function groupObservationsByDay(
	items: ObservationItemView[],
): ObservationDay[] {
	const byDay = new Map<string, ObservationItemView[]>();
	for (const item of items) {
		const day = item.occurredAt.slice(0, 10);
		const dayItems = byDay.get(day);
		if (dayItems) dayItems.push(item);
		else byDay.set(day, [item]);
	}

	return [...byDay.entries()]
		.sort(([a], [b]) => b.localeCompare(a))
		.map(([day, dayItems]) => ({
			day,
			items: [...dayItems].sort(
				(a, b) =>
					a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
			),
		}));
}
