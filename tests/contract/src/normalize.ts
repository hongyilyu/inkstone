import {
	asObject,
	asStringArray,
	type JsonObject,
	type JsonValue,
} from "@inkstone/protocol";

// The parity normalizer: a pure function applied to BOTH the Rust fixture and
// the `JSONSchema.make` output before deep-equality, reconciling the two
// Draft-07 dialects down to a common form. Each rule names the dialect quirk it
// cancels. Kept tight on purpose — too loose hides real drift, too strict goes
// red on cosmetics. The correctness test: `create_person` is green, and flipping
// one field's type in the Effect schema turns it red.
//
// Dialects (verified, see FEATURE-PLAN.md "Verified facts"):
// A schema document is JSON, so `JsonValue`/`JsonObject` (@inkstone/protocol) are
// the node types throughout and `asObject` is the only narrowing needed.
//
// - Rust (`crates/core/src/field_spec.rs`): inline Draft-07, no `$schema`, no
//   `$ref`/`$defs`, no `title`; `additionalProperties:false` always; `required`
//   OMITTED when empty; object keys BTreeMap-sorted.
// - Effect (`JSONSchema.make`, effect 3.21.2): emits `$schema`; `required:[]`
//   present even when empty; injects combinator `title` (and `description`,
//   which the schema builders in `schemas.ts` suppress); built-in `S.Unknown`
//   emits an annotation-only `$id`; `required` ordered before `properties`; emits
//   unions as `anyOf` (Rust emits `oneOf`) and COLLAPSES a 1-element union to its
//   bare member (Rust keeps `oneOf:[X]`).

/** Schema-map keywords: their VALUE is a map of arbitrary names → subschemas
 * (`properties.title` is a field literally named "title", NOT a `title`
 * annotation). The per-node keyword rewrites in `walk1` (which delete keys like
 * `title`/`$schema`) must NOT run on these maps, or a real field named after a
 * keyword would be silently dropped — hiding drift on it. Their values are still
 * walked as ordinary subschemas. */
const SCHEMA_MAP_KEYS = new Set([
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
]);

/** The recursive walk. `inSchemaMap` is true when `value` is the VALUE of a
 * schema-map keyword (a `name → subschema` map), so the keyword rewrites are
 * skipped for it. */
const walk = (value: JsonValue, inSchemaMap = false): JsonValue => {
	if (Array.isArray(value)) return value.map((item) => walk(item));
	const object = asObject(value);
	if (object === null) return value;

	// Inside a schema map (e.g. the object under `properties`), the keys are
	// arbitrary field names — skip `walk1` so a field named `title`/`$schema`/etc.
	// is preserved. Its values are walked as ordinary subschemas below.
	if (inSchemaMap) {
		const mapped: JsonObject = {};
		for (const [key, child] of Object.entries(object)) {
			mapped[key] = walk(child);
		}
		return sortKeys(mapped);
	}

	const node = walk1(object);

	// Rule 8b — unwrap a single-element `oneOf`. After rule 8a (`anyOf → oneOf`)
	// both dialects key the journal body union as `oneOf`. A union of ONE member
	// is semantically identical to that member (`oneOf:[X]` validates exactly as
	// `X`), but the two dialects disagree on the wrapper: Rust always emits
	// `oneOf:[…]` (even the `TextOnly` body → `oneOf:[text_node]`), while
	// `JSONSchema.make` COLLAPSES a 1-element `S.Union(X)` to the bare `X`. We
	// reconcile by collapsing too — replace `{oneOf:[X]}` with the normalized
	// `X`. Applied SYMMETRICALLY to both sides, so it never hides a real
	// difference: a 2-element `oneOf` is left intact (drift in any member still
	// bites), and a 1-vs-2 variant mismatch survives (one side collapses to the
	// bare member, the other keeps `oneOf:[A,B]` — still unequal). Only a lone
	// `oneOf` key qualifies; a `oneOf` alongside sibling constraints is left
	// wrapped (none occur in these schemas, but staying conservative is safer).
	const only = node.oneOf;
	if (
		Array.isArray(only) &&
		only.length === 1 &&
		Object.keys(node).length === 1
	) {
		return walk(only[0]);
	}

	const out: JsonObject = {};
	for (const [key, child] of Object.entries(node)) {
		out[key] = walk(child, SCHEMA_MAP_KEYS.has(key));
	}
	return sortKeys(out);
};

/** Per-node, pre-recursion rewrites: strip `$schema`/`title`, and collapse an
 * empty `required` to absent. */
const walk1 = (node: JsonObject) => {
	const out = { ...node };

	// Rule 1 — strip `$schema`. Effect stamps the dialect URI on the root; Rust
	// never emits it.
	delete out.$schema;

	// Rule 3 — strip `title`. Effect injects a combinator title (e.g.
	// `"minLength(1)"`); Rust never emits `title`. (Rule 4 — combinator
	// `description` noise — is handled at the source in `schemas.ts`, which
	// suppresses the injected `description` so only the real LocalDateTime one
	// survives; nothing to strip here.)
	delete out.title;

	// Rule 3b — strip Effect's annotation-only ids for leaf schemas.
	// Rust's unconstrained schema fragments are bare `{}`; Effect emits `S.Unknown`
	// as `{ "$id": "/schemas/unknown", "title": "unknown" }`. `S.Never` likewise
	// stamps `/schemas/never` beside its real `{not:{}}` predicate. The title is
	// gone by rule 3; these ids carry no validation semantics.
	if (out.$id === "/schemas/unknown" || out.$id === "/schemas/never") {
		delete out.$id;
	}

	// Rule 5 — empty `required` ≡ absent. Rust omits `required` when no field is
	// required; Effect emits `required:[]`. Delete the empty array so both read
	// the same.
	if (Array.isArray(out.required) && out.required.length === 0) {
		delete out.required;
	}

	// Rule 8a — `anyOf → oneOf`. The journal `body` is a union of tagged node
	// variants. Rust emits the union as `oneOf`; `JSONSchema.make` emits it as
	// `anyOf`. Rename `anyOf` to the Rust key so both compare under one name. The
	// variant array is POSITIONAL (`text_node` first) and must NOT be sorted —
	// rule 7 sorts only the `required`/`enum` SETS, never `oneOf`/`anyOf` — so
	// reordered or differing variants still bite. The `S.Union(...)` members in
	// `schemas.ts` are declared text-node-first to match Rust's order. (Rule 8b
	// in `walk` then collapses a resulting single-element `oneOf`.)
	if (Array.isArray(out.anyOf) && out.oneOf === undefined) {
		out.oneOf = out.anyOf;
		delete out.anyOf;
	}

	// Rule 7 — canonicalize the element order of `required` and `enum`. Both are
	// JSON-Schema SETS (order is semantically meaningless), but the two dialects
	// emit different orders: Effect follows struct-field / literal declaration
	// order, Rust follows the order fields are pushed in `mutation.rs` / the enum
	// domain-slice order. Sorting their (string-only) elements canonicalizes
	// order WITHOUT losing information — a missing, extra, or changed member
	// still differs after both sides sort, so this stays drift-safe. ONLY these
	// two arrays: every other array (`items`, `oneOf`, `anyOf`, `prefixItems`,
	// `month_days` values, …) is POSITIONAL and must NOT be sorted, or we'd hide
	// real drift or corrupt meaning.
	for (const key of ["required", "enum"] as const) {
		const values = out[key];
		if (!Array.isArray(values)) continue;
		const strings = asStringArray(values);
		// Only a wholly-string set is sortable — `asStringArray` drops non-strings,
		// so an equal length means every element was one.
		if (strings.length === values.length) out[key] = strings.sort();
	}

	return out;
};

/** Rule 6 — deep key-sort. Effect orders `required` before `properties`; Rust
 * is BTreeMap-sorted. Canonicalize both by sorting every object's keys. */
const sortKeys = (node: JsonObject) => {
	const sorted: JsonObject = {};
	for (const key of Object.keys(node).sort()) {
		sorted[key] = node[key];
	}
	return sorted;
};

/** Normalize a Draft-07 schema (from either dialect) to the common form. */
export const normalize = (schema: JsonValue): JsonValue => walk(schema);
