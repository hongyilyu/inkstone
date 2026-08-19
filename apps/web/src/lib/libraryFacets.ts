// The pure facet engine for the Library collections. A PURE LEAF — it imports
// only entity types + the field/relationship helpers from libraryItems/entityFields
// (no React, no components), so EntityCollection can wire state → compose → render
// while every narrowing/counting rule is unit-tested here in isolation.
//
// Facets are layered OVER the existing text search, not instead of it: callers pass
// a `base` list (already query-ranked by `searchLibraryItems`, or kind-sorted when
// the query is empty) and the engine narrows it. Semantics (ADR-0035 rides this —
// purely client-side, no entity FTS):
//   • AND across facet TYPES (status ∧ the text query).
//   • OR WITHIN a multi-select facet (status active OR completed).

import { assertNever } from "./assertNever";
import { MEDIA_MEDIUMS, MEDIA_STATES, PROJECT_STATUSES } from "./entityFields";
import type { LibraryItem, LibraryItemKind } from "./libraryItems";

/** The facet kinds the collections offer: Project's status axis plus Media's
 * medium/state axes (ADR-0059). */
export type FacetKey = "status" | "medium" | "state";

/** The user's current facet selection. Every axis is multi-select (OR within). */
export interface ActiveFacets {
	statuses: ReadonlySet<string>;
	mediums: ReadonlySet<string>;
	states: ReadonlySet<string>;
}

/** Each facet key and the `ActiveFacets` Set field it toggles. A `Record` over
 * the union makes the map exhaustive: a new `FacetKey` forces an entry here (and
 * a typed field name keeps the Set updates honest). */
const MULTI_SELECT_FIELD = {
	status: "statuses",
	medium: "mediums",
	state: "states",
} satisfies Record<FacetKey, "statuses" | "mediums" | "states">;

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
	mediums: new Set(),
	states: new Set(),
};

/** Is `value` currently selected under facet `key`? (For rendering a chip's
 * pressed state.) */
export function isFacetActive(
	active: ActiveFacets,
	key: FacetKey,
	value: string,
): boolean {
	if (key === "status") return active.statuses.has(value);
	if (key === "medium") return active.mediums.has(value);
	if (key === "state") return active.states.has(value);
	return assertNever(key, "facet key");
}

/** Whether any facet at all is selected (drives the inline Clear affordance). */
export function hasActiveFacets(active: ActiveFacets): boolean {
	return (
		active.statuses.size > 0 ||
		active.mediums.size > 0 ||
		active.states.size > 0
	);
}

/** Toggle `value` under facet `key`, returning a fresh `ActiveFacets` (never
 * mutates). Every axis is multi-select — toggle membership of its Set. */
export function toggleFacet(
	active: ActiveFacets,
	key: FacetKey,
	value: string,
): ActiveFacets {
	const field = MULTI_SELECT_FIELD[key];
	const next = new Set(active[field]);
	if (next.has(value)) next.delete(value);
	else next.add(value);
	return { ...active, [field]: next };
}

const GROUP_LABEL = {
	status: "Status",
	medium: "Medium",
	state: "State",
} satisfies Record<FacetKey, string>;

/** Which facets a kind offers at all (before checking whether the data can
 * partition). Project has a status axis; Media has medium/state; the rest are
 * search-only. */
export function facetsForKind(kind: LibraryItemKind): FacetKey[] {
	if (kind === "project") return ["status"];
	if (kind === "media") return ["medium", "state"];
	return [];
}

/** A row's status value, or undefined for kinds without one. */
function statusOf(item: LibraryItem): string | undefined {
	return item.kind === "project" ? item.status : undefined;
}

/** A Media row's medium, or undefined for any other kind. */
function mediumOf(item: LibraryItem): string | undefined {
	return item.kind === "media" ? item.medium : undefined;
}

/** A Media row's lifecycle state, or undefined for any other kind. */
function stateOf(item: LibraryItem): string | undefined {
	return item.kind === "media" ? item.state : undefined;
}

function matchesStatus(item: LibraryItem, active: ActiveFacets): boolean {
	if (active.statuses.size === 0) return true;
	const s = statusOf(item);
	return s != null && active.statuses.has(s);
}

function matchesMedium(item: LibraryItem, active: ActiveFacets): boolean {
	if (active.mediums.size === 0) return true;
	const m = mediumOf(item);
	return m != null && active.mediums.has(m);
}

function matchesState(item: LibraryItem, active: ActiveFacets): boolean {
	if (active.states.size === 0) return true;
	const s = stateOf(item);
	return s != null && active.states.has(s);
}

/** Narrow `base` by every active facet (AND across types, OR within each). `base`
 * is assumed already query-filtered/sorted by the caller; this only applies facets,
 * preserving `base`'s order. */
export function composeFacets(
	base: readonly LibraryItem[],
	active: ActiveFacets,
): LibraryItem[] {
	return base.filter(
		(item) =>
			matchesStatus(item, active) &&
			matchesMedium(item, active) &&
			matchesState(item, active),
	);
}

/** Drop one facet's own selection, leaving the others — the "leave-one-out" basis
 * for that facet's chip counts. */
function withoutOwn(active: ActiveFacets, key: FacetKey): ActiveFacets {
	if (key === "status") return { ...active, statuses: new Set() };
	if (key === "medium") return { ...active, mediums: new Set() };
	if (key === "state") return { ...active, states: new Set() };
	return assertNever(key, "facet key");
}

/** The value of `item` under one facet key (each row carries at most one). */
function valuesOf(item: LibraryItem, key: FacetKey): string[] {
	if (key === "status") {
		const s = statusOf(item);
		return s == null ? [] : [s];
	}
	if (key === "medium") {
		const m = mediumOf(item);
		return m == null ? [] : [m];
	}
	if (key === "state") {
		const s = stateOf(item);
		return s == null ? [] : [s];
	}
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
): Map<string, number> {
	const pool = composeFacets(base, withoutOwn(active, key));
	const counts = new Map<string, number>();
	for (const item of pool) {
		for (const value of valuesOf(item, key)) {
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
	}
	return counts;
}

/** Status values actually present in `ofKind`, in canonical domain order, labelled. */
function presentStatusValues(ofKind: readonly LibraryItem[]): FacetValue[] {
	const present = new Set<string>();
	for (const item of ofKind) {
		const s = statusOf(item);
		if (s != null) present.add(s);
	}
	return PROJECT_STATUSES.filter((o) => present.has(o.value)).map((o) => ({
		value: o.value,
		label: o.label,
	}));
}

/** Medium values present in `ofKind`, in canonical `MEDIA_MEDIUMS` order, labelled. */
function presentMediumValues(ofKind: readonly LibraryItem[]): FacetValue[] {
	const present = new Set<string>();
	for (const item of ofKind) {
		const m = mediumOf(item);
		if (m != null) present.add(m);
	}
	return MEDIA_MEDIUMS.filter((o) => present.has(o.value)).map((o) => ({
		value: o.value,
		label: o.label,
	}));
}

/** State values present in `ofKind`, in canonical `MEDIA_STATES` order, labelled. */
function presentStateValues(ofKind: readonly LibraryItem[]): FacetValue[] {
	const present = new Set<string>();
	for (const item of ofKind) {
		const s = stateOf(item);
		if (s != null) present.add(s);
	}
	return MEDIA_STATES.filter((o) => present.has(o.value)).map((o) => ({
		value: o.value,
		label: o.label,
	}));
}

/** The facet groups to render for `ofKind`: a group appears only if the kind offers
 * it AND the UNFILTERED set holds ≥2 distinct values for it (so a facet that can't
 * partition the list never shows a dead single chip). Group/value membership is
 * computed against the unfiltered `ofKind` so groups don't flicker as the user
 * toggles — only individual chips dim/hide later via `facetCounts`. */
export function deriveFacets(
	kind: LibraryItemKind,
	ofKind: readonly LibraryItem[],
): FacetGroup[] {
	const groups: FacetGroup[] = [];
	for (const key of facetsForKind(kind)) {
		const values =
			key === "status"
				? presentStatusValues(ofKind)
				: key === "medium"
					? presentMediumValues(ofKind)
					: key === "state"
						? presentStateValues(ofKind)
						: assertNever(key, "facet key");
		if (values.length >= 2) {
			groups.push({ key, label: GROUP_LABEL[key], values });
		}
	}
	return groups;
}
