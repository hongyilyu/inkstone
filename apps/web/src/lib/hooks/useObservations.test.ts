import type { ObservationRow } from "@inkstone/protocol";
import { describe, expect, it } from "vitest";
import { assembleObservationItems } from "./useObservations.js";

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

describe("assembleObservationItems", () => {
	it("maps each row through toObservationView", () => {
		const items = assembleObservationItems([
			row({ id: "bw", schema_key: "bodyweight", values: { kg: 72.4 } }),
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("bw");
		expect(items[0]?.summary).toContain("72.4 kg");
	});

	it("an empty observation list yields []", () => {
		expect(assembleObservationItems([])).toEqual([]);
	});
});
