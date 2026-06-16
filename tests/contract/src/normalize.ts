// The parity normalizer: a pure function applied to BOTH the Rust fixture and
// the `JSONSchema.make` output before deep-equality, reconciling the two
// Draft-07 dialects down to a common form. Each rule names the dialect quirk it
// cancels. Kept tight on purpose — too loose hides real drift, too strict goes
// red on cosmetics. The correctness test: `create_todo` is green, and flipping
// one field's type in the Effect schema turns it red.
//
// Dialects (verified, see FEATURE-PLAN.md "Verified facts"):
// - Rust (`crates/core/src/field_spec.rs`): inline Draft-07, no `$schema`, no
//   `$ref`/`$defs`, no `title`; `additionalProperties:false` always; `required`
//   OMITTED when empty; object keys BTreeMap-sorted.
// - Effect (`JSONSchema.make`, effect 3.21.2): emits `$schema`; `required:[]`
//   present even when empty; injects combinator `title` (and `description`,
//   which the schema builders in `schemas.ts` suppress); `required` ordered
//   before `properties`; emits unions as `anyOf` (Rust emits `oneOf`) and
//   COLLAPSES a 1-element union to its bare member (Rust keeps `oneOf:[X]`).

type Json = unknown;

const isObject = (value: Json): value is Record<string, Json> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolve `{ "$ref": "#/$defs/X", ...siblings }` to the referenced node merged
 * with its siblings, against the document's `$defs` block. */
const resolveRef = (
	node: Record<string, Json>,
	defs: Record<string, Json>,
): Record<string, Json> => {
	const ref = node.$ref;
	if (typeof ref !== "string") return node;
	const name = ref.replace(/^#\/\$defs\//, "");
	const target = defs[name];
	const resolved = isObject(target) ? target : {};
	const { $ref: _drop, ...siblings } = node;
	return { ...resolved, ...siblings };
};

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

/** The recursive walk. `defs` carries the top-level `$defs` block (if any) so
 * nested `$ref`s resolve against it; the block itself is dropped at the root.
 * `inSchemaMap` is true when `value` is the VALUE of a schema-map keyword (a
 * `name → subschema` map), so the keyword rewrites are skipped for it. */
const walk = (
	value: Json,
	defs: Record<string, Json>,
	inSchemaMap = false,
): Json => {
	if (Array.isArray(value)) return value.map((item) => walk(item, defs));
	if (!isObject(value)) return value;

	// Inside a schema map (e.g. the object under `properties`), the keys are
	// arbitrary field names — skip `walk1` so a field named `title`/`$schema`/etc.
	// is preserved. Its values are walked as ordinary subschemas below.
	if (inSchemaMap) {
		const mapped: Record<string, Json> = {};
		for (const [key, child] of Object.entries(value)) {
			mapped[key] = walk(child, defs);
		}
		return sortKeys(mapped);
	}

	// Rule 2 — inline `$ref` + drop `$defs`. Effect hoists `S.Int` to
	// `#/$defs/Int`; Rust inlines every schema (ADR-0018: Anthropic rejects
	// `$ref`). The `schemas.ts` builders avoid the hoist (plain `S.Number`), so
	// this is a safety net that keeps the normalizer correct if a future schema
	// reintroduces a `$ref`.
	const node = walk1(
		value.$ref !== undefined ? resolveRef(value, defs) : value,
	);

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
	const only = isObject(node) ? node.oneOf : undefined;
	if (
		Array.isArray(only) &&
		only.length === 1 &&
		Object.keys(node).length === 1
	) {
		return walk(only[0], defs);
	}

	const out: Record<string, Json> = {};
	for (const [key, child] of Object.entries(node)) {
		out[key] = walk(child, defs, SCHEMA_MAP_KEYS.has(key));
	}
	return sortKeys(out);
};

/** Per-node, pre-recursion rewrites: strip `$schema`/`title`, and collapse an
 * empty `required` to absent. */
const walk1 = (node: Record<string, Json>): Record<string, Json> => {
	const out: Record<string, Json> = { ...node };

	// Rule 1 — strip `$schema`. Effect stamps the dialect URI on the root; Rust
	// never emits it.
	delete out.$schema;

	// Rule 3 — strip `title`. Effect injects a combinator title (e.g.
	// `"minLength(1)"`); Rust never emits `title`. (Rule 4 — combinator
	// `description` noise — is handled at the source in `schemas.ts`, which
	// suppresses the injected `description` so only the real LocalDateTime one
	// survives; nothing to strip here.)
	delete out.title;

	// Rule 2 (cont.) — drop the top-level `$defs` block once its members have
	// been inlined.
	delete out.$defs;

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
		const arr = out[key];
		if (Array.isArray(arr) && arr.every((m) => typeof m === "string")) {
			out[key] = [...(arr as string[])].sort();
		}
	}

	return out;
};

/** Rule 6 — deep key-sort. Effect orders `required` before `properties`; Rust
 * is BTreeMap-sorted. Canonicalize both by sorting every object's keys. */
const sortKeys = (node: Record<string, Json>): Record<string, Json> => {
	const sorted: Record<string, Json> = {};
	for (const key of Object.keys(node).sort()) {
		sorted[key] = node[key];
	}
	return sorted;
};

/** Normalize a Draft-07 schema (from either dialect) to the common form. */
export const normalize = (schema: Json): Json => {
	const defs = isObject(schema) && isObject(schema.$defs) ? schema.$defs : {};
	return walk(schema, defs);
};
