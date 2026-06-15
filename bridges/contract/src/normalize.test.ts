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
