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

describe("normalize: $ref inlining + $defs drop (rule 2)", () => {
	// This rule is a safety net: today's schemas use `S.Number` (not `S.Int`) to
	// dodge `JSONSchema.make`'s `#/$defs/Int` hoist, so no live parity assertion
	// exercises it. Pin it directly so a regression in `resolveRef` (wrong prefix
	// strip, sibling-merge precedence, or a missed `$defs` drop) can't silently
	// defeat the gate if a future schema reintroduces a `$ref`.
	it("inlines a `$ref` merged with its siblings and drops `$defs`", () => {
		const hoisted = {
			$defs: { Int: { type: "integer", description: "an integer" } },
			type: "object",
			properties: { n: { $ref: "#/$defs/Int", minimum: 1 } },
		};
		const inlined = {
			type: "object",
			properties: {
				n: { type: "integer", description: "an integer", minimum: 1 },
			},
		};
		expect(normalize(hoisted)).toStrictEqual(normalize(inlined));
	});

	it("still bites when the referenced target differs", () => {
		const refInt = {
			$defs: { T: { type: "integer" } },
			properties: { n: { $ref: "#/$defs/T" } },
		};
		const refString = {
			$defs: { T: { type: "string" } },
			properties: { n: { $ref: "#/$defs/T" } },
		};
		expect(normalize(refInt)).not.toStrictEqual(normalize(refString));
	});
});
