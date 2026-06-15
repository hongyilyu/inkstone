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
//   before `properties`.

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

/** The recursive walk. `defs` carries the top-level `$defs` block (if any) so
 * nested `$ref`s resolve against it; the block itself is dropped at the root. */
const walk = (value: Json, defs: Record<string, Json>): Json => {
	if (Array.isArray(value)) return value.map((item) => walk(item, defs));
	if (!isObject(value)) return value;

	// Rule 2 — inline `$ref` + drop `$defs`. Effect hoists `S.Int` to
	// `#/$defs/Int`; Rust inlines every schema (ADR-0018: Anthropic rejects
	// `$ref`). The `schemas.ts` builders avoid the hoist (plain `S.Number`), so
	// this is a safety net that keeps the normalizer correct if a future schema
	// reintroduces a `$ref`.
	const node = walk1(
		value.$ref !== undefined ? resolveRef(value, defs) : value,
	);

	const out: Record<string, Json> = {};
	for (const [key, child] of Object.entries(node)) {
		out[key] = walk(child, defs);
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
