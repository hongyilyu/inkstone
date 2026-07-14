// Unit pins for the parity normalizer's set-canonicalization rule (rule 7):
// `required` and `enum` are JSON-Schema SETS, so the normalizer must compare
// them order-insensitively — yet a missing/extra member must still differ
// (set-difference bites). Every other array stays positional.

import { describe, expect, it } from "vitest";
import { normalize } from "./normalize.js";

describe("normalize: required/enum are order-insensitive sets", () => {
	it("`required` member order does not matter", () => {
		const a = { type: "object", required: ["a", "b", "c"] };
		const b = { type: "object", required: ["c", "a", "b"] };
		expect(normalize(a)).toStrictEqual(normalize(b));
	});

	it("`required` set-difference still bites (missing member)", () => {
		const full = { type: "object", required: ["a", "b", "c"] };
		const missing = { type: "object", required: ["a", "b"] };
		expect(normalize(full)).not.toStrictEqual(normalize(missing));
	});

	it("`enum` member order does not matter", () => {
		const a = { type: "string", enum: ["mon", "tue", "wed"] };
		const b = { type: "string", enum: ["wed", "mon", "tue"] };
		expect(normalize(a)).toStrictEqual(normalize(b));
	});

	it("`enum` set-difference still bites (changed member)", () => {
		const a = { type: "string", enum: ["mon", "tue", "wed"] };
		const b = { type: "string", enum: ["mon", "tue", "thu"] };
		expect(normalize(a)).not.toStrictEqual(normalize(b));
	});

	it("positional arrays keep their order (only_on.month_days)", () => {
		// `month_days` values are positional; sorting them would corrupt meaning,
		// so the normalizer must leave their order alone.
		const a = { type: "array", items: [{ const: 3 }, { const: 1 }] };
		const b = { type: "array", items: [{ const: 1 }, { const: 3 }] };
		expect(normalize(a)).not.toStrictEqual(normalize(b));
	});
});

describe("normalize: journal body union (rules 8a/8b)", () => {
	it("rule 8a — `anyOf` (Effect) ≡ `oneOf` (Rust) for the same variants", () => {
		const effect = { anyOf: [{ const: "a" }, { const: "b" }] };
		const rust = { oneOf: [{ const: "a" }, { const: "b" }] };
		expect(normalize(effect)).toStrictEqual(normalize(rust));
	});

	it("rule 8b — `oneOf:[X]` (Rust) ≡ bare `X` (Effect-collapsed)", () => {
		// Rust always wraps the body union, even `TextOnly` → `oneOf:[text]`;
		// `JSONSchema.make` collapses a 1-member union to the bare member.
		const rust = { oneOf: [{ type: "object", required: ["type"] }] };
		const effectCollapsed = { type: "object", required: ["type"] };
		expect(normalize(rust)).toStrictEqual(normalize(effectCollapsed));
	});

	it("union variant order is positional — reordering still bites", () => {
		// The variant array is NOT a set (unlike `required`/`enum`): `text_node`
		// must stay first. Swapping members must NOT compare equal.
		const a = { oneOf: [{ const: "text" }, { const: "entity_ref" }] };
		const b = { anyOf: [{ const: "entity_ref" }, { const: "text" }] };
		expect(normalize(a)).not.toStrictEqual(normalize(b));
	});

	it("a 2-member union does NOT collapse (variant drift still bites)", () => {
		// Only a single-element union unwraps; a 1-vs-2 variant mismatch survives.
		const oneVariant = { oneOf: [{ const: "text" }] };
		const twoVariant = { oneOf: [{ const: "text" }, { const: "entity_ref" }] };
		expect(normalize(oneVariant)).not.toStrictEqual(normalize(twoVariant));
	});
});

describe("normalize: unconstrained schema annotations (rule 3b)", () => {
	it("Effect S.Unknown annotation id compares as Rust's bare any schema", () => {
		const effectUnknown = { $id: "/schemas/unknown", title: "unknown" };
		const rustAny = {};
		expect(normalize(effectUnknown)).toStrictEqual(normalize(rustAny));
	});
});

describe("normalize: keyword rewrites skip schema-map values (rule 3 scope)", () => {
	// Regression guard: the `title`-strip (rule 3) and the other per-node keyword
	// rewrites must apply to schema NODES, not to the arbitrary field-name keys
	// inside a `properties` map. `create_todo`/`update_todo` both have a field
	// literally named `title`; an earlier normalizer deleted it everywhere, so
	// drift on a `title` field passed silently. These pin that the field survives
	// AND that the combinator `title` annotation is still stripped.
	it("preserves a field literally named `title` inside `properties`", () => {
		const withMin = {
			type: "object",
			properties: { title: { type: "string", minLength: 1 } },
			required: ["title"],
		};
		const withoutMin = {
			type: "object",
			properties: { title: { type: "string" } },
			required: ["title"],
		};
		// The `title` FIELD must survive normalization...
		expect(JSON.stringify(normalize(withMin))).toContain('"title"');
		// ...and a real difference on it must still bite (not be hidden).
		expect(normalize(withMin)).not.toStrictEqual(normalize(withoutMin));
	});

	it("still strips a combinator `title` ANNOTATION on a schema node", () => {
		const annotated = { type: "string", minLength: 1, title: "minLength(1)" };
		const bare = { type: "string", minLength: 1 };
		expect(normalize(annotated)).toStrictEqual(normalize(bare));
	});

	it("preserves a `$schema`-named field inside `properties` too", () => {
		// The same hazard for any keyword the node rewrites delete.
		const a = { properties: { $schema: { type: "string", minLength: 1 } } };
		const b = { properties: { $schema: { type: "string" } } };
		expect(JSON.stringify(normalize(a))).toContain("$schema");
		expect(normalize(a)).not.toStrictEqual(normalize(b));
	});
});
