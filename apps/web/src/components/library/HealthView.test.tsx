import type { ObservationRow } from "@inkstone/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toObservationView } from "@/lib/observationView";
import { type HealthFilter, HealthView } from "./HealthView";

// HealthView reads its data straight from `useObservations`; mock the hook so the
// test controls the rows, the pending state, and the error state without a live
// runtime. Filter still comes from props (the route owns it).
const useObservations = vi.fn();
vi.mock("@/lib/hooks/useObservations", () => ({
	useObservations: () => useObservations(),
}));

// The correction surface drives `useObservationUpdate`; mock it so the test captures
// the mutate params (proving the source-free draft) without a live runtime/cue.
const mutate = vi.fn();
vi.mock("@/lib/hooks/useObservationUpdate", () => ({
	useObservationUpdate: () => ({ mutate, isPending: false, error: null }),
}));

afterEach(() => {
	cleanup();
	useObservations.mockReset();
	mutate.mockReset();
});

const row = (
	over: Partial<ObservationRow> & Pick<ObservationRow, "schema_key" | "values">,
): ObservationRow => ({
	id: "obs",
	schema_version: 1,
	occurred_at: "2026-06-10T09:00:00",
	ended_at: null,
	note: null,
	source: null,
	created_at: 1000,
	updated_at: 1000,
	...over,
});

// Day A (06-10): a bodyweight row sourced from a Journal Entry + a habit.checkin
// row (no source). Day B (06-09): an unknown-schema row (no source).
// A real UUID id: the correction form validates the assembled draft against
// `ObservationUpdateParams`, whose `observation_id` carries the canonical UUID pattern.
const BODYWEIGHT_ID = "01900000-0000-7000-8000-0000000000ab";
const bodyweight = toObservationView(
	row({
		id: BODYWEIGHT_ID,
		occurred_at: "2026-06-10T07:00:00",
		schema_key: "bodyweight",
		values: { kg: 72.4 },
		source: { relation: "created_from", source_entity_id: "je-1" },
	}),
);
const habit = toObservationView(
	row({
		id: "hb",
		occurred_at: "2026-06-10T08:00:00",
		schema_key: "habit.checkin",
		values: { habit_id: "abcd1234-5678-9012-3456-7890abcdef00", state: "done" },
	}),
);
const unknown = toObservationView(
	row({
		id: "un",
		occurred_at: "2026-06-09T08:00:00",
		schema_key: "sleep.session",
		values: { hours: 7 },
	}),
);

const ALL = [bodyweight, habit, unknown];

function mockData(items: typeof ALL) {
	useObservations.mockReturnValue({
		data: items,
		isPending: false,
		isError: false,
	});
}

/** Drives the controlled HealthView; clicking a chip flips `filter` locally. */
function Stateful({ initial }: { initial?: HealthFilter }) {
	const [filter, setFilter] = useState<HealthFilter>(initial);
	return <HealthView filter={filter} onFilterChange={setFilter} />;
}

describe("HealthView", () => {
	it("renders day group headers, newest day first", () => {
		mockData(ALL);
		render(<Stateful />);
		const headers = screen.getAllByRole("heading", { level: 2 });
		expect(headers.length).toBe(2);
		// Two distinct days; newest (06-10) heads the list.
		expect(headers[0]?.textContent).not.toBe(headers[1]?.textContent);
	});

	it("polishes a known schema and falls back to raw key + JSON for unknown", () => {
		mockData(ALL);
		render(<Stateful />);
		// Polished bodyweight summary (also echoed in its Weight field row, so the
		// text legitimately appears more than once — assert presence, not uniqueness).
		expect(screen.getAllByText("72.4 kg").length).toBeGreaterThan(0);
		// Unknown schema degrades to raw key + JSON, no crash.
		expect(screen.getByText("sleep.session")).toBeInTheDocument();
		expect(screen.getByText('{"hours":7}')).toBeInTheDocument();
	});

	it("offers an All chip plus one chip per known schema present", () => {
		mockData(ALL);
		render(<Stateful />);
		expect(screen.getByRole("button", { name: /^all/i })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /bodyweight/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /habits/i })).toBeInTheDocument();
	});

	it("clicking a schema chip narrows the stream to that schema", async () => {
		mockData(ALL);
		render(<Stateful />);
		// Under All, both the bodyweight and the habit row render.
		expect(screen.getAllByText("72.4 kg").length).toBeGreaterThan(0);
		expect(screen.getByText(/Habit ·/)).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /bodyweight/i }));

		// Only bodyweight survives the filter.
		expect(screen.getAllByText("72.4 kg").length).toBeGreaterThan(0);
		expect(screen.queryByText(/Habit ·/)).not.toBeInTheDocument();
	});

	it("renders only the bodyweight stream when controlled with filter=bodyweight", () => {
		mockData(ALL);
		render(<HealthView filter="bodyweight" onFilterChange={() => {}} />);
		expect(screen.getAllByText("72.4 kg").length).toBeGreaterThan(0);
		expect(screen.queryByText(/Habit ·/)).not.toBeInTheDocument();
		expect(screen.queryByText("sleep.session")).not.toBeInTheDocument();
	});

	it("calls onFilterChange with the schema key when a chip is clicked", async () => {
		mockData(ALL);
		const onFilterChange = vi.fn();
		render(<HealthView filter={undefined} onFilterChange={onFilterChange} />);
		await userEvent.click(screen.getByRole("button", { name: /habits/i }));
		expect(onFilterChange).toHaveBeenCalledWith("habit.checkin");
	});

	it("shows 'Captured from' exactly once — only for the sourced row", () => {
		mockData(ALL);
		render(<Stateful />);
		expect(screen.getAllByText(/captured from/i)).toHaveLength(1);
		expect(
			screen.getByText(/captured from a journal entry/i),
		).toBeInTheDocument();
	});

	it("labels an evidenced_by (message) source as 'Captured from a message'", () => {
		mockData([
			toObservationView(
				row({
					id: "msg",
					schema_key: "bodyweight",
					values: { kg: 70 },
					source: { relation: "evidenced_by", source_message_id: "m-1" },
				}),
			),
		]);
		render(<Stateful />);
		expect(screen.getByText(/captured from a message/i)).toBeInTheDocument();
		expect(
			screen.queryByText(/captured from a journal entry/i),
		).not.toBeInTheDocument();
	});

	it("renders the plain empty state when there are no observations", () => {
		mockData([]);
		render(<Stateful />);
		expect(screen.getByText(/no observations yet/i)).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load health/i)).not.toBeInTheDocument();
	});

	it("keeps the active filter chip and shows filter-specific empty copy when the filter matches nothing", () => {
		// Route-controlled filter on a schema with zero rows (e.g. a bookmarked
		// `?schema=habit.checkin` while only bodyweight exists): the chip must stay
		// visible to clear, and the empty copy must not claim the workspace is empty.
		mockData([bodyweight]); // only a bodyweight row exists
		render(<HealthView filter="habit.checkin" onFilterChange={() => {}} />);
		expect(screen.getByRole("button", { name: /habits/i })).toBeInTheDocument();
		expect(screen.getByText(/no habits observations yet/i)).toBeInTheDocument();
		expect(screen.queryByText(/^no observations yet/i)).not.toBeInTheDocument();
	});

	it("renders the danger empty state on read error", () => {
		useObservations.mockReturnValue({
			data: undefined,
			isPending: false,
			isError: true,
		});
		render(<Stateful />);
		expect(screen.getByText(/couldn't load health/i)).toBeInTheDocument();
	});

	describe("correction flow", () => {
		it("opens a form pre-filled with the row's current occurred_at + values", async () => {
			mockData(ALL);
			render(<Stateful />);
			// One Correct button per row; click the bodyweight row's.
			const corrects = screen.getAllByRole("button", { name: /^correct$/i });
			expect(corrects.length).toBe(ALL.length);
			await userEvent.click(corrects[0] as HTMLElement);

			// occurred_at seeded from the stored wall-clock string (with seconds).
			expect(
				screen.getByDisplayValue("2026-06-10T07:00:00"),
			).toBeInTheDocument();
			// values textarea pre-filled with the row's current values (pretty JSON).
			const valuesField = screen.getByLabelText(/^values$/i);
			expect((valuesField as HTMLTextAreaElement).value).toContain(
				'"kg": 72.4',
			);
		});

		it("submits a SOURCE-FREE full-replacement draft (no schema_key, no source)", async () => {
			mockData(ALL);
			render(<Stateful />);
			await userEvent.click(
				screen.getAllByRole("button", { name: /^correct$/i })[0] as HTMLElement,
			);

			// Edit the values (change kg) then save. `paste` sets the textarea verbatim
			// — `type` would interpret JSON braces/brackets as userEvent key syntax.
			const valuesField = screen.getByLabelText(
				/^values$/i,
			) as HTMLTextAreaElement;
			await userEvent.clear(valuesField);
			valuesField.focus();
			await userEvent.paste('{"kg": 73.1}');
			await userEvent.click(
				screen.getByRole("button", { name: /save correction/i }),
			);

			expect(mutate).toHaveBeenCalledTimes(1);
			const params = mutate.mock.calls[0]?.[0];
			expect(params.observation_id).toBe(BODYWEIGHT_ID);
			expect(params.observation.occurred_at).toBe("2026-06-10T07:00:00");
			expect(params.observation.values).toEqual({ kg: 73.1 });
			// Source-free full replacement: provenance fields never reach the wire.
			expect("schema_key" in params.observation).toBe(false);
			expect("source" in params.observation).toBe(false);
		});

		it("leaves the 'Captured from' provenance line unchanged while correcting", async () => {
			mockData(ALL);
			render(<Stateful />);
			expect(
				screen.getByText(/captured from a journal entry/i),
			).toBeInTheDocument();
			await userEvent.click(
				screen.getAllByRole("button", { name: /^correct$/i })[0] as HTMLElement,
			);
			// Provenance is immutable + display-only — still present with the editor open.
			expect(
				screen.getByText(/captured from a journal entry/i),
			).toBeInTheDocument();
		});

		it("keeps a single active editor — opening Correct on one row doesn't open another", async () => {
			mockData(ALL);
			render(<Stateful />);
			const corrects = screen.getAllByRole("button", { name: /^correct$/i });
			await userEvent.click(corrects[0] as HTMLElement);
			expect(screen.getAllByLabelText(/^values$/i).length).toBe(1);
			await userEvent.click(corrects[1] as HTMLElement);
			// Still exactly one open editor (the second row's), not two.
			expect(screen.getAllByLabelText(/^values$/i).length).toBe(1);
		});
	});
});
