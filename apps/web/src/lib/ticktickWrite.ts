// TickTick write-card helpers (ticktick-writes W3): the due tuple's display
// label, the edit form's draft seed/build (full-payload REPLACE semantics),
// and the local-wall-time → instant conversion the edit form needs (the wire
// due.date is an OFFSET-BEARING instant — W1: TickTick parses a naive
// datetime as UTC, so the browser owns the zone math).

import type { JsonObject, JsonValue } from "@inkstone/protocol";
import { asObject, readString } from "@/lib/readPayload";

/** The proposed due tuple, read defensively off the (unvalidated) payload. */
export interface ProposedDue {
	readonly date: string;
	readonly isAllDay: boolean;
	readonly timeZone: string;
}

export function readDue(payload: JsonValue): ProposedDue | null {
	const due = asObject(asObject(payload)?.due);
	if (due === null) {
		return null;
	}
	const date = typeof due.date === "string" ? due.date : "";
	if (date === "") {
		return null;
	}
	return {
		date,
		isAllDay: due.is_all_day === true,
		timeZone: typeof due.time_zone === "string" ? due.time_zone : "",
	};
}

/** Parse a wire due instant: TickTick spells the offset without a colon
 * (`+0000`), which `Date.parse` needs. */
function parseWireInstant(value: string): Date {
	return new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

/** Render the one due tuple localized (all-day date vs timed instant), BOTH in
 * `time_zone` — an all-day instant rendered in UTC would show the previous
 * day west of Greenwich (mirrors TasksView's DueLabel). */
export function dueLabel(due: ProposedDue): string {
	const date = parseWireInstant(due.date);
	if (Number.isNaN(date.getTime())) {
		return due.date;
	}
	const timeZone = due.timeZone || undefined;
	return due.isAllDay
		? date.toLocaleDateString(undefined, { timeZone })
		: date.toLocaleString(undefined, { timeZone });
}

/** The edit form's draft: local date/time fields + the all-day toggle + the
 * zone the instant is interpreted in. */
export interface TickTickEditDraft {
	readonly title: string;
	readonly note: string;
	/** `YYYY-MM-DD`; empty = no due. */
	readonly date: string;
	/** `HH:MM`; empty = all-day (clearing the time sets is_all_day). */
	readonly time: string;
	readonly timeZone: string;
}

/** The browser's IANA zone — the "Core-local" fallback when the proposed
 * payload carries none. */
function browserTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Seed the edit draft from the proposed payload: the instant decomposed into
 * local wall date/time IN the payload's zone (else the browser's). */
export function seedTickTickDraft(payload: JsonValue): TickTickEditDraft {
	const due = readDue(payload);
	const timeZone = due?.timeZone || browserTimeZone();
	let date = "";
	let time = "";
	if (due !== null) {
		const instant = parseWireInstant(due.date);
		if (!Number.isNaN(instant.getTime())) {
			const parts = wallParts(instant.getTime(), timeZone);
			date = `${parts.year}-${parts.month}-${parts.day}`;
			time = due.isAllDay ? "" : `${parts.hour}:${parts.minute}`;
		}
	}
	return {
		title: readString(payload, "title"),
		note: readString(payload, "note"),
		date,
		time,
		timeZone,
	};
}

/** An instant's wall-clock pieces in a zone, as `Intl` renders them. */
interface WallParts {
	readonly year: string;
	readonly month: string;
	readonly day: string;
	readonly hour: string;
	readonly minute: string;
	readonly second: string;
}

/** Decompose an instant into wall-clock parts in `timeZone`. */
function wallParts(ms: number, timeZone: string): WallParts {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const parts = formatter.formatToParts(ms);
	const read = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? "";
	const hour = read("hour");
	return {
		year: read("year"),
		month: read("month"),
		day: read("day"),
		// Some engines render midnight as "24".
		hour: hour === "24" ? "00" : hour,
		minute: read("minute"),
		second: read("second"),
	};
}

/** Interpret `date` + `time` as WALL time in `timeZone` and return the epoch
 * ms of that instant, or `null` for an unparseable input/zone. Two-pass
 * offset correction handles DST boundaries. */
export function zonedWallTimeToEpochMs(
	date: string,
	time: string,
	timeZone: string,
): number | null {
	const guess = Date.parse(`${date}T${time.length > 0 ? time : "00:00"}:00Z`);
	if (Number.isNaN(guess)) {
		return null;
	}
	const offsetAt = (ms: number): number | null => {
		try {
			const parts = wallParts(ms, timeZone);
			const asUtc = Date.UTC(
				Number(parts.year),
				Number(parts.month) - 1,
				Number(parts.day),
				Number(parts.hour),
				Number(parts.minute),
				Number(parts.second),
			);
			return asUtc - ms;
		} catch {
			return null; // an invalid IANA zone throws in Intl
		}
	};
	const first = offsetAt(guess);
	if (first === null) {
		return null;
	}
	const second = offsetAt(guess - first);
	if (second === null) {
		return null;
	}
	return guess - second;
}

/** Build the FULL effective payload from the draft (replace semantics, like
 * every non-Todo kind since ADR-0033): `{title, note?, due?}`. Returns `null`
 * with a reason when the draft cannot form a valid payload. */
export function buildTickTickPayload(
	draft: TickTickEditDraft,
): { payload: JsonObject } | { issue: string } {
	const title = draft.title.trim();
	if (title === "") {
		return { issue: "title must not be empty" };
	}
	const payload: JsonObject = { title };
	if (draft.note !== "") {
		payload.note = draft.note;
	}
	if (draft.date !== "") {
		const isAllDay = draft.time === "";
		const timeZone = draft.timeZone.trim() || browserTimeZone();
		const ms = zonedWallTimeToEpochMs(draft.date, draft.time, timeZone);
		if (ms === null) {
			return { issue: "due date is not a valid date/time" };
		}
		// The `Z` instant spelling — one of the offset forms the wire accepts.
		payload.due = {
			date: new Date(ms).toISOString(),
			is_all_day: isAllDay,
			time_zone: timeZone,
		};
	}
	return { payload };
}
