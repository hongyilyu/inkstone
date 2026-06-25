// The pure facet engine for the Library collections. A PURE LEAF — it imports
// only entity types + the field/relationship helpers from libraryItems/entityFields
// (no React, no components), so EntityCollection can wire state → compose → render
// while every narrowing/counting rule is unit-tested here in isolation.
//
// Facets are layered OVER the existing text search, not instead of it: callers pass
// a `base` list (already query-ranked by `searchLibraryItems`, or kind-sorted when
// the query is empty) and the engine narrows it. Semantics (ADR-0035 rides this —
// purely client-side, no entity FTS):
//   • AND across facet TYPES (status ∧ date ∧ person ∧ the text query).
//   • OR WITHIN a multi-select facet (status active OR completed; person A OR B).
//   • Date is single-select (the presets are mutually exclusive).
// Date presets are PURELY date-based, independent of status, so Date ⟂ Status
// compose honestly (a completed-yet-overdue todo is still "overdue").

import { assertNever } from "./assertNever";
import { PROJECT_STATUSES, TODO_STATUSES } from "./entityFields";
import {
	type LibraryItem,
	type LibraryItemKind,
	localNowString,
	todosForProject,
} from "./libraryItems";

/** The three facet kinds this feature ships (GTD-core). */
export type FacetKey = "status" | "date" | "person";

/** A Todo due-date preset. `no_date` = no due date; a dated-but-beyond-horizon
 * todo belongs to NO preset (its `dateBucket` is null). */
export type DatePreset = "overdue" | "due_soon" | "no_date";

/** The user's current facet selection. Status/person are multi-select (OR within);
 * date is single-select (or null = inactive). */
export interface ActiveFacets {
	statuses: ReadonlySet<string>;
	date: DatePreset | null;
	people: ReadonlySet<string>;
}

/** A facet value the UI renders as one chip. */
export interface FacetValue {
	value: string;
	label: string;
}

/** A renderable facet group: its key, a leading label, and the present values. */
export interface FacetGroup {
	key: FacetKey;
	label: string;
	values: FacetValue[];
}

/** No facets active — the default selection. Treat as immutable; build fresh Sets
 * when toggling rather than mutating these. */
export const EMPTY_FACETS: ActiveFacets = {
	statuses: new Set(),
	date: null,
	people: new Set(),
};

/** Is `value` currently selected under facet `key`? (For rendering a chip's
 * pressed state.) */
export function isFacetActive(
	active: ActiveFacets,
	key: FacetKey,
	value: string,
): boolean {
	if (key === "status") return active.statuses.has(value);
	if (key === "date") return active.date === value;
	if (key === "person") return active.people.has(value);
	return assertNever(key, "facet key");
}

/** Whether any facet at all is selected (drives the inline Clear affordance). */
export function hasActiveFacets(active: ActiveFacets): boolean {
	return (
		active.statuses.size > 0 || active.date != null || active.people.size > 0
	);
}

/** Toggle `value` under facet `key`, returning a fresh `ActiveFacets` (never
 * mutates). Status/person are multi-select (toggle membership of the Set); date is
 * single-select (selecting clears any other preset, re-selecting clears it). */
export function toggleFacet(
	active: ActiveFacets,
	key: FacetKey,
	value: string,
): ActiveFacets {
	if (key === "date") {
		return {
			...active,
			date: active.date === value ? null : (value as DatePreset),
		};
	}
	if (key !== "status" && key !== "person")
		return assertNever(key, "facet key");
	const field = key === "status" ? "statuses" : "people";
	const next = new Set(active[field]);
	if (next.has(value)) next.delete(value);
	else next.add(value);
	return { ...active, [field]: next };
}

/** "Due soon" horizon: a todo due within this many days (inclusive of today) is
 * "due soon"; matches the spirit of `dueSoonTodos`' default window, widened to a
 * week so the preset is a useful forward view. */
const DUE_SOON_DAYS = 7;

const DATE_ORDER: DatePreset[] = ["overdue", "due_soon", "no_date"];
const DATE_LABEL: Record<DatePreset, string> = {
	overdue: "Overdue",
	due_soon: "Due soon",
	no_date: "No date",
};

const GROUP_LABEL: Record<FacetKey, string> = {
	status: "Status",
	date: "Due",
	person: "People",
};

/** Which facets a kind offers at all (before checking whether the data can
 * partition). Todo gets the full set; Project has no due date; the rest are
 * search-only. */
export function facetsForKind(kind: LibraryItemKind): FacetKey[] {
	if (kind === "todo") return ["status", "date", "person"];
	if (kind === "project") return ["status", "person"];
	return [];
}

/** A Todo's date bucket, computed PURELY from its due date vs `now` (status is
 * irrelevant). Returns null for a non-todo or a todo dated beyond the soon
 * horizon (a real date that fits no preset — distinct from `no_date`). */
export function dateBucket(
	item: LibraryItem,
	now: Date = new Date(),
): DatePreset | null {
	if (item.kind !== "todo") return null;
	if (item.dueAt == null) return "no_date";
	const dueDay = item.dueAt.slice(0, 10);
	const todayDay = localNowString(now).slice(0, 10);
	if (dueDay < todayDay) return "overdue";
	const horizon = new Date(now);
	horizon.setDate(horizon.getDate() + DUE_SOON_DAYS);
	const horizonDay = localNowString(horizon).slice(0, 10);
	if (dueDay <= horizonDay) return "due_soon";
	return null;
}

/** A row's status value, or undefined for kinds without one. */
function statusOf(item: LibraryItem): string | undefined {
	return item.kind === "todo" || item.kind === "project"
		? item.status
		: undefined;
}

/** The Person ids a row is associated with, by kind:
 *  - todo: its `personRefs` (direct, ADR-0032)
 *  - project: derived through the Project's Todos' Person References (Project →
 *    Todo → TodoPersonRef, ADR-0031). Distinct ids — a Person linked through
 *    several of the Project's Todos counts once.
 *  - everything else: none.
 *
 * (ADR-0050 retired `peopleForProject`; this keeps the same client-side
 * Project → Todo → Person join over `todosForProject`, which is still exported.) */
function associatedPersonIds(
	item: LibraryItem,
	allItems: readonly LibraryItem[],
): string[] {
	if (item.kind === "todo") return item.personRefs.map((r) => r.personId);
	if (item.kind === "project") {
		const ids = new Set<string>();
		// `allItems as LibraryItem[]` strips readonly for todosForProject's signature
		// (it doesn't mutate); `item` is already narrowed to Project by the guard.
		for (const todo of todosForProject(allItems as LibraryItem[], item)) {
			for (const ref of todo.personRefs) ids.add(ref.personId);
		}
		return [...ids];
	}
	return [];
}

function matchesStatus(item: LibraryItem, active: ActiveFacets): boolean {
	if (active.statuses.size === 0) return true;
	const s = statusOf(item);
	return s != null && active.statuses.has(s);
}

function matchesDate(
	item: LibraryItem,
	active: ActiveFacets,
	now: Date,
): boolean {
	if (active.date == null) return true;
	return dateBucket(item, now) === active.date;
}

function matchesPeople(
	item: LibraryItem,
	active: ActiveFacets,
	allItems: readonly LibraryItem[],
): boolean {
	if (active.people.size === 0) return true;
	return associatedPersonIds(item, allItems).some((id) =>
		active.people.has(id),
	);
}

/** Narrow `base` by every active facet (AND across types, OR within each). `base`
 * is assumed already query-filtered/sorted by the caller; this only applies facets,
 * preserving `base`'s order. */
export function composeFacets(
	base: readonly LibraryItem[],
	active: ActiveFacets,
	allItems: readonly LibraryItem[],
	now: Date = new Date(),
): LibraryItem[] {
	return base.filter(
		(item) =>
			matchesStatus(item, active) &&
			matchesDate(item, active, now) &&
			matchesPeople(item, active, allItems),
	);
}

/** Drop one facet's own selection, leaving the others — the "leave-one-out" basis
 * for that facet's chip counts. */
function withoutOwn(active: ActiveFacets, key: FacetKey): ActiveFacets {
	if (key === "status") return { ...active, statuses: new Set() };
	if (key === "date") return { ...active, date: null };
	if (key === "person") return { ...active, people: new Set() };
	return assertNever(key, "facet key");
}

/** The value(s) of `item` under one facet key (a row can carry several people but
 * exactly one status / date bucket). */
function valuesOf(
	item: LibraryItem,
	key: FacetKey,
	allItems: readonly LibraryItem[],
	now: Date,
): string[] {
	if (key === "status") {
		const s = statusOf(item);
		return s == null ? [] : [s];
	}
	if (key === "date") {
		const b = dateBucket(item, now);
		return b == null ? [] : [b];
	}
	if (key === "person") return associatedPersonIds(item, allItems);
	return assertNever(key, "facet key");
}

/** Leave-one-out, context-aware counts for one facet's chips: how many rows would
 * remain per value, honoring all OTHER active facets (and whatever query is already
 * baked into `base`) but IGNORING this facet's own selection — so a second value in
 * a multi-select facet still shows a usable count and OR stays discoverable. */
export function facetCounts(
	key: FacetKey,
	base: readonly LibraryItem[],
	active: ActiveFacets,
	allItems: readonly LibraryItem[],
	now: Date = new Date(),
): Map<string, number> {
	const pool = composeFacets(base, withoutOwn(active, key), allItems, now);
	const counts = new Map<string, number>();
	for (const item of pool) {
		for (const value of valuesOf(item, key, allItems, now)) {
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
	}
	return counts;
}

function statusDomain(
	kind: LibraryItemKind,
): readonly { value: string; label: string }[] {
	return kind === "project" ? PROJECT_STATUSES : TODO_STATUSES;
}

/** Status values actually present in `ofKind`, in canonical domain order, labelled. */
function presentStatusValues(
	kind: LibraryItemKind,
	ofKind: readonly LibraryItem[],
): FacetValue[] {
	const present = new Set<string>();
	for (const item of ofKind) {
		const s = statusOf(item);
		if (s != null) present.add(s);
	}
	return statusDomain(kind)
		.filter((o) => present.has(o.value))
		.map((o) => ({ value: o.value, label: o.label }));
}

/** Date presets actually populated in `ofKind`, in fixed order, labelled. A
 * beyond-horizon todo contributes no preset. */
function presentDateValues(
	ofKind: readonly LibraryItem[],
	now: Date,
): FacetValue[] {
	const present = new Set<DatePreset>();
	for (const item of ofKind) {
		const b = dateBucket(item, now);
		if (b != null) present.add(b);
	}
	return DATE_ORDER.filter((p) => present.has(p)).map((p) => ({
		value: p,
		label: DATE_LABEL[p],
	}));
}

/** People associated with `ofKind`, resolved to names, ordered by descending
 * association count then name. */
function presentPersonValues(
	ofKind: readonly LibraryItem[],
	allItems: readonly LibraryItem[],
): FacetValue[] {
	const counts = new Map<string, number>();
	for (const item of ofKind) {
		for (const id of associatedPersonIds(item, allItems)) {
			counts.set(id, (counts.get(id) ?? 0) + 1);
		}
	}
	const nameById = new Map<string, string>();
	for (const item of allItems) {
		if (item.kind === "person") nameById.set(item.id, item.name);
	}
	return [...counts.entries()]
		.map(([id, count]) => ({ value: id, label: nameById.get(id) ?? id, count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
		.map(({ value, label }) => ({ value, label }));
}

/** The facet groups to render for `ofKind`: a group appears only if the kind offers
 * it AND the UNFILTERED set holds ≥2 distinct values for it (so a facet that can't
 * partition the list never shows a dead single chip). Group/value membership is
 * computed against the unfiltered `ofKind` so groups don't flicker as the user
 * toggles — only individual chips dim/hide later via `facetCounts`. */
export function deriveFacets(
	kind: LibraryItemKind,
	ofKind: readonly LibraryItem[],
	allItems: readonly LibraryItem[],
	now: Date = new Date(),
): FacetGroup[] {
	const groups: FacetGroup[] = [];
	for (const key of facetsForKind(kind)) {
		const values =
			key === "status"
				? presentStatusValues(kind, ofKind)
				: key === "date"
					? presentDateValues(ofKind, now)
					: key === "person"
						? presentPersonValues(ofKind, allItems)
						: assertNever(key, "facet key");
		if (values.length >= 2) {
			groups.push({ key, label: GROUP_LABEL[key], values });
		}
	}
	return groups;
}
