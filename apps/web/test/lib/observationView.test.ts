import type { ObservationRow } from "@inkstone/protocol";
import { describe, expect, it } from "vitest";
import {
	groupObservationsByDay,
	type ObservationItemView,
	toObservationView,
} from "@/lib/observationView.js";

const row = (
	over: Partial<ObservationRow> & Pick<ObservationRow, "schema_key" | "values">,
): ObservationRow => ({
	id: "obs-1",
	schema_version: 1,
	occurred_at: "2026-06-10T09:00:00",
	ended_at: null,
	note: null,
	source: null,
	created_at: 1000,
	updated_at: 1000,
	...over,
});

const fieldsText = (v: ObservationItemView): string =>
	v.fields.map((f) => `${f.label}=${f.value}`).join(" ");

describe("toObservationView — known schema polish", () => {
	it("bodyweight renders the weight in kg", () => {
		const v = toObservationView(
			row({ schema_key: "bodyweight", values: { kg: 72.4 } }),
		);
		expect(v.summary).toContain("72.4 kg");
	});

	it("habit.checkin shows Habit · <short-id>, state, and quantity when present", () => {
		const v = toObservationView(
			row({
				schema_key: "habit.checkin",
				values: {
					habit_id: "abcd1234-5678-9012-3456-7890abcdef00",
					state: "done",
					quantity: 3,
				},
			}),
		);
		expect(v.summary).toContain("Habit · abcd1234");
		const text = fieldsText(v);
		expect(text).toContain("done");
		expect(text).toContain("3");
	});

	it("habit.checkin without quantity omits it", () => {
		const v = toObservationView(
			row({
				schema_key: "habit.checkin",
				values: {
					habit_id: "abcd1234-5678-9012-3456-7890abcdef00",
					state: "skipped",
				},
			}),
		);
		expect(v.fields.some((f) => /quantity/i.test(f.label))).toBe(false);
		expect(fieldsText(v)).toContain("skipped");
	});

	it("habit.checkin renders the missed state", () => {
		const v = toObservationView(
			row({
				schema_key: "habit.checkin",
				values: {
					habit_id: "abcd1234-5678-9012-3456-7890abcdef00",
					state: "missed",
				},
			}),
		);
		expect(fieldsText(v)).toContain("missed");
	});
});

describe("toObservationView — graceful fallback (load-bearing)", () => {
	it("an unknown schema_key renders raw key + JSON and does not throw", () => {
		const r = row({ schema_key: "sleep.session", values: { hours: 7 } });
		expect(() => toObservationView(r)).not.toThrow();
		const v = toObservationView(r);
		expect(v.summary).toContain("sleep.session");
		expect(fieldsText(v)).toContain('{"hours":7}');
	});

	it("a known schema_key whose values fail to decode degrades to the JSON fallback", () => {
		const r = row({ schema_key: "bodyweight", values: { kg: "heavy" } });
		expect(() => toObservationView(r)).not.toThrow();
		const v = toObservationView(r);
		expect(fieldsText(v)).toContain('{"kg":"heavy"}');
	});

	it.each([
		"constructor",
		"toString",
		"valueOf",
		"hasOwnProperty",
		"__proto__",
	])("a schema_key naming an Object.prototype member (%s) falls back without throwing", (schemaKey) => {
		const r = row({ schema_key: schemaKey, values: { hours: 7 } });
		expect(() => toObservationView(r)).not.toThrow();
		const v = toObservationView(r);
		expect(v.summary).toBe(schemaKey);
		expect(fieldsText(v)).toContain('{"hours":7}');
	});

	it("a values payload that JSON.stringify cannot serialize falls back without throwing", () => {
		// Wire `values` is always JSON-tree data, but the never-throw contract is
		// absolute — a non-wire caller passing a BigInt (or circular) must degrade,
		// not throw out of `JSON.stringify`.
		const r = row({ schema_key: "sleep.session", values: { big: 10n } });
		expect(() => toObservationView(r)).not.toThrow();
		expect(fieldsText(toObservationView(r))).toContain("[unserializable]");
	});
});

describe("toObservationView — source threading", () => {
	it("carries a present source through the polished branch", () => {
		const v = toObservationView(
			row({
				schema_key: "bodyweight",
				values: { kg: 70 },
				source: { relation: "created_from", source_entity_id: "je-1" },
			}),
		);
		expect(v.source).toEqual({
			relation: "created_from",
			source_entity_id: "je-1",
		});
	});

	it("carries a null source through the fallback branch", () => {
		const v = toObservationView(
			row({ schema_key: "sleep.session", values: { hours: 7 }, source: null }),
		);
		expect(v.source).toBeNull();
	});
});

describe("toObservationView — raw values threading (correction pre-fill)", () => {
	it("carries the raw values object through the polished branch", () => {
		const v = toObservationView(
			row({ schema_key: "bodyweight", values: { kg: 72.4 } }),
		);
		expect(v.values).toEqual({ kg: 72.4 });
	});

	it("carries the raw values object through the fallback branch", () => {
		const v = toObservationView(
			row({ schema_key: "sleep.session", values: { hours: 7 } }),
		);
		expect(v.values).toEqual({ hours: 7 });
	});
});

describe("groupObservationsByDay", () => {
	it("buckets by occurred_at day, newest day first, ascending within a day", () => {
		const items = [
			toObservationView(
				row({
					id: "a",
					occurred_at: "2026-06-10T12:00:00",
					schema_key: "bodyweight",
					values: { kg: 70 },
				}),
			),
			toObservationView(
				row({
					id: "b",
					occurred_at: "2026-06-10T08:00:00",
					schema_key: "bodyweight",
					values: { kg: 71 },
				}),
			),
			toObservationView(
				row({
					id: "c",
					occurred_at: "2026-06-11T08:00:00",
					schema_key: "bodyweight",
					values: { kg: 72 },
				}),
			),
		];
		const days = groupObservationsByDay(items);
		expect(days.map((d) => d.day)).toEqual(["2026-06-11", "2026-06-10"]);
		expect(days[1]?.items.map((i) => i.id)).toEqual(["b", "a"]);
	});
});
