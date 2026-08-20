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
	// LOCALE-INDEPENDENT: `dueLabel` renders through the ambient locale (a
	// `de-DE` runner shows `1.9.2026`), so the expectation is built from the
	// same `Intl` call — what is asserted is the ZONE handling (which day, which
	// wall time), not a presentation format.
	it("renders all-day as a date and timed as an instant, both in the tuple's zone", () => {
		const zone = "America/Los_Angeles";
		// 07:00Z on Sep 1 = midnight PDT: the all-day label must land on Sep 1 in
		// the zone, not drift a day via a UTC rendering.
		const allDay = dueLabel({
			date: "2026-09-01T07:00:00.000+0000",
			isAllDay: true,
			timeZone: zone,
		});
		expect(allDay).toBe(
			new Date("2026-09-01T07:00:00.000Z").toLocaleDateString(undefined, {
				timeZone: zone,
			}),
		);
		// The zone-correct calendar day, asserted without a format assumption.
		expect(
			new Intl.DateTimeFormat("en-CA", {
				timeZone: zone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).format(new Date("2026-09-01T07:00:00.000Z")),
		).toBe("2026-09-01");

		// 00:30Z Sep 2 = 17:30 PDT Sep 1 — a timed due renders date AND time.
		const timed = dueLabel({
			date: "2026-09-02T00:30:00.000+0000",
			isAllDay: false,
			timeZone: zone,
		});
		expect(timed).toBe(
			new Date("2026-09-02T00:30:00.000Z").toLocaleString(undefined, {
				timeZone: zone,
			}),
		);
		expect(timed).not.toBe(allDay);
		expect(
			new Intl.DateTimeFormat("en-GB", {
				timeZone: zone,
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}).format(new Date("2026-09-02T00:30:00.000Z")),
		).toBe("17:30");
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

describe("an invalid time_zone never crashes the card", () => {
	// The payload is unvalidated wire data and `Intl` THROWS on an unrecognized
	// zone — inside the edit form's useState initializer, which would take the
	// whole card render down.
	const bogus = {
		title: "buy milk",
		due: {
			date: "2026-09-02T00:30:00.000+0000",
			is_all_day: false,
			time_zone: "Not/AZone",
		},
	};

	it("seedTickTickDraft falls back to the browser zone", () => {
		const draft = seedTickTickDraft(bogus);
		expect(draft.timeZone).toBe(
			Intl.DateTimeFormat().resolvedOptions().timeZone,
		);
		expect(draft.date).not.toBe("");
	});

	it("dueLabel renders instead of throwing", () => {
		expect(() =>
			dueLabel({
				date: "2026-09-02T00:30:00.000+0000",
				isAllDay: false,
				timeZone: "Not/AZone",
			}),
		).not.toThrow();
	});

	it("buildTickTickPayload substitutes a usable zone", () => {
		const built = buildTickTickPayload({
			title: "buy milk",
			note: "",
			date: "2026-09-01",
			time: "17:30",
			timeZone: "Not/AZone",
		});
		if ("issue" in built) {
			throw new Error(`unexpected issue: ${built.issue}`);
		}
		expect(built.payload.due).toMatchObject({
			time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
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
