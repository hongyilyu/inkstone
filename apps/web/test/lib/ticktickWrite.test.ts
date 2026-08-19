// The TickTick write-card helpers (ticktick-writes W3): the due tuple
// display, the edit draft seed, and the wall-time → instant conversion that
// keeps the wire's offset-bearing contract (W1: a naive datetime is parsed as
// UTC by TickTick, so the browser owns the zone math).

import { describe, expect, it } from "vitest";
import {
	buildTickTickPayload,
	dueLabel,
	readDue,
	seedTickTickDraft,
	zonedWallTimeToEpochMs,
} from "@/lib/ticktickWrite";

describe("readDue", () => {
	it("reads the tuple defensively and degrades malformed shapes to null", () => {
		expect(
			readDue({
				title: "x",
				due: {
					date: "2026-09-01T17:30:00.000+0000",
					is_all_day: false,
					time_zone: "America/Los_Angeles",
				},
			}),
		).toEqual({
			date: "2026-09-01T17:30:00.000+0000",
			isAllDay: false,
			timeZone: "America/Los_Angeles",
		});
		expect(readDue({ title: "x" })).toBeNull();
		expect(readDue(null)).toBeNull();
		expect(readDue({ due: { is_all_day: true } })).toBeNull();
		expect(readDue({ due: { date: 42 } })).toBeNull();
	});
});

describe("dueLabel", () => {
	it("renders all-day as a date and timed as a localized instant, both in the tuple's zone", () => {
		// 07:00Z on Sep 1 = midnight PDT: the all-day label must say Sep 1 (the
		// zone), not fall back to a UTC rendering that could drift a day.
		const allDay = dueLabel({
			date: "2026-09-01T07:00:00.000+0000",
			isAllDay: true,
			timeZone: "America/Los_Angeles",
		});
		expect(allDay).toContain("2026");
		expect(allDay).toMatch(/9\/1|09\/01|Sep/);

		const timed = dueLabel({
			date: "2026-09-02T00:30:00.000+0000",
			isAllDay: false,
			timeZone: "America/Los_Angeles",
		});
		// 00:30Z Sep 2 = 17:30 PDT Sep 1.
		expect(timed).toMatch(/5:30|17:30/);
	});

	it("degrades an unparseable date to the raw string", () => {
		expect(
			dueLabel({ date: "not-a-date", isAllDay: false, timeZone: "" }),
		).toBe("not-a-date");
	});
});

describe("zonedWallTimeToEpochMs", () => {
	it("interprets wall time in the zone (PDT and PST differ)", () => {
		// 2026-09-01 17:30 in LA is PDT (UTC-7) → 2026-09-02T00:30Z.
		expect(
			zonedWallTimeToEpochMs("2026-09-01", "17:30", "America/Los_Angeles"),
		).toBe(Date.parse("2026-09-02T00:30:00Z"));
		// 2026-12-01 17:30 in LA is PST (UTC-8) → 2026-12-02T01:30Z.
		expect(
			zonedWallTimeToEpochMs("2026-12-01", "17:30", "America/Los_Angeles"),
		).toBe(Date.parse("2026-12-02T01:30:00Z"));
		// An empty time means midnight.
		expect(
			zonedWallTimeToEpochMs("2026-09-01", "", "America/Los_Angeles"),
		).toBe(Date.parse("2026-09-01T07:00:00Z"));
	});

	it("returns null for an unparseable date or an invalid zone", () => {
		expect(zonedWallTimeToEpochMs("nope", "17:30", "UTC")).toBeNull();
		expect(
			zonedWallTimeToEpochMs("2026-09-01", "17:30", "Not/AZone"),
		).toBeNull();
	});
});

describe("seedTickTickDraft ⇄ buildTickTickPayload", () => {
	it("seeds the draft from the proposed payload in the payload's zone", () => {
		const draft = seedTickTickDraft({
			title: "buy milk",
			note: "2%",
			due: {
				date: "2026-09-02T00:30:00.000+0000",
				is_all_day: false,
				time_zone: "America/Los_Angeles",
			},
		});
		expect(draft.title).toBe("buy milk");
		expect(draft.note).toBe("2%");
		expect(draft.date).toBe("2026-09-01");
		expect(draft.time).toBe("17:30");
		expect(draft.timeZone).toBe("America/Los_Angeles");
	});

	it("seeds an all-day due with an empty time", () => {
		const draft = seedTickTickDraft({
			title: "buy milk",
			due: {
				date: "2026-09-01T07:00:00.000+0000",
				is_all_day: true,
				time_zone: "America/Los_Angeles",
			},
		});
		expect(draft.date).toBe("2026-09-01");
		expect(draft.time).toBe("");
	});

	it("builds the FULL effective payload (replace semantics)", () => {
		const built = buildTickTickPayload({
			title: " buy oat milk ",
			note: "",
			date: "2026-09-01",
			time: "17:30",
			timeZone: "America/Los_Angeles",
		});
		if ("issue" in built) {
			throw new Error(`unexpected issue: ${built.issue}`);
		}
		expect(built.payload).toEqual({
			title: "buy oat milk",
			due: {
				date: "2026-09-02T00:30:00.000Z",
				is_all_day: false,
				time_zone: "America/Los_Angeles",
			},
		});
	});

	it("clearing the time sets is_all_day at local midnight in the zone", () => {
		const built = buildTickTickPayload({
			title: "buy milk",
			note: "",
			date: "2026-09-01",
			time: "",
			timeZone: "America/Los_Angeles",
		});
		if ("issue" in built) {
			throw new Error(`unexpected issue: ${built.issue}`);
		}
		expect(built.payload.due).toEqual({
			date: "2026-09-01T07:00:00.000Z",
			is_all_day: true,
			time_zone: "America/Los_Angeles",
		});
	});

	it("an empty date means no due; a blank title or bad date is an issue", () => {
		const noDue = buildTickTickPayload({
			title: "x",
			note: "n",
			date: "",
			time: "",
			timeZone: "UTC",
		});
		if ("issue" in noDue) {
			throw new Error(`unexpected issue: ${noDue.issue}`);
		}
		expect(noDue.payload).toEqual({ title: "x", note: "n" });

		expect(
			buildTickTickPayload({
				title: "  ",
				note: "",
				date: "",
				time: "",
				timeZone: "UTC",
			}),
		).toEqual({ issue: "title must not be empty" });
		expect(
			buildTickTickPayload({
				title: "x",
				note: "",
				date: "nope",
				time: "17:30",
				timeZone: "UTC",
			}),
		).toEqual({ issue: "due date is not a valid date/time" });
	});
});
