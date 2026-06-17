import { describe, expect, it } from "vitest";
import {
	formatRunTime,
	RUN_HISTORY_VIEWS,
	runHistoryBucket,
} from "./runHistory";

// A fixed "now" so the calendar-day boundaries are deterministic: noon local time
// avoids any same-day ambiguity at the edges we assert.
const NOW = new Date(2026, 5, 16, 12, 0, 0).getTime(); // Tue 2026-06-16 12:00 local
const DAY = 86_400_000;
const startOfToday = new Date(NOW).setHours(0, 0, 0, 0);

describe("runHistoryBucket", () => {
	it("buckets a timestamp from today as Today", () => {
		expect(runHistoryBucket(NOW, NOW)).toBe("Today");
		// The exact start-of-today boundary is inclusive.
		expect(runHistoryBucket(startOfToday, NOW)).toBe("Today");
	});

	it("buckets the prior calendar day as Yesterday", () => {
		expect(runHistoryBucket(startOfToday - 1, NOW)).toBe("Yesterday");
		expect(runHistoryBucket(startOfToday - DAY, NOW)).toBe("Yesterday");
	});

	it("buckets 2–6 days ago as Earlier this week", () => {
		// Just before the yesterday window opens.
		expect(runHistoryBucket(startOfToday - DAY - 1, NOW)).toBe(
			"Earlier this week",
		);
		// The far edge of the week window (6 days back) is still in it.
		expect(runHistoryBucket(startOfToday - 6 * DAY, NOW)).toBe(
			"Earlier this week",
		);
	});

	it("buckets anything older than a week as Older", () => {
		expect(runHistoryBucket(startOfToday - 6 * DAY - 1, NOW)).toBe("Older");
		expect(runHistoryBucket(startOfToday - 30 * DAY, NOW)).toBe("Older");
	});
});

describe("formatRunTime", () => {
	it("shows a clock time for a same-day timestamp", () => {
		// 09:05 today → the locale's hour:minute time string (not a date). Compare
		// against the same Intl formatting so the assertion is locale-independent.
		const at = new Date(2026, 5, 16, 9, 5, 0).getTime();
		expect(formatRunTime(at, NOW)).toBe(
			new Date(at).toLocaleTimeString(undefined, {
				hour: "numeric",
				minute: "2-digit",
			}),
		);
	});

	it("shows a month/day stamp for an older timestamp", () => {
		// 10 days ago → the locale's short month/day date (not a clock time).
		const at = NOW - 10 * DAY;
		expect(formatRunTime(at, NOW)).toBe(
			new Date(at).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			}),
		);
		// And it is NOT the same-day time form.
		expect(formatRunTime(at, NOW)).not.toBe(
			new Date(at).toLocaleTimeString(undefined, {
				hour: "numeric",
				minute: "2-digit",
			}),
		);
	});
});

describe("RUN_HISTORY_VIEWS", () => {
	it("maps every Run Log kind to a distinct label, with resumed reading as live", () => {
		expect(RUN_HISTORY_VIEWS.proposal_decided.label).toBe("Running, resumed");
		expect(RUN_HISTORY_VIEWS.proposal_decided.tone).toBe("active");
		// proposal_pending and parked share the "Waiting" presentation.
		expect(RUN_HISTORY_VIEWS.proposal_pending.label).toBe("Waiting");
		expect(RUN_HISTORY_VIEWS.parked.label).toBe("Waiting");
		// Terminal kinds recede (neutral); only failure is the alert tone.
		expect(RUN_HISTORY_VIEWS.done.tone).toBe("neutral");
		expect(RUN_HISTORY_VIEWS.cancelled.tone).toBe("neutral");
		expect(RUN_HISTORY_VIEWS.error.label).toBe("Failed");
		expect(RUN_HISTORY_VIEWS.error.tone).toBe("alert");
		expect(RUN_HISTORY_VIEWS.running.tone).toBe("active");
	});
});
