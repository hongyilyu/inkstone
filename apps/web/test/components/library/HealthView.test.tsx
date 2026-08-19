import type {
	ObservationRow,
	ObservationUpdateParams,
} from "@inkstone/protocol";
import { WsRequestError } from "@inkstone/ui-sdk";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HealthFilter, HealthView } from "@/components/library/HealthView";

// HealthView reads through the REAL `useObservations`/`useObservationUpdate` hooks
// over a stubbed WsClient (`renderWithCore`): the test drives `observation/query`
// and `observation/update` at the wire seam, so the hooks' own query/mutation
// wiring — refetch on success, error surfacing, `reset` on open/switch/cancel — is
// exercised rather than mocked away. Filter still comes from props (the route owns
// it).

afterEach(cleanup);

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
// Real UUID ids: the correction form validates the assembled draft against
// `ObservationUpdateParams`, whose `observation_id` carries the canonical UUID pattern
// — a non-UUID id would make the form's own draft validation (not the row's content)
// surface an alert, which the cross-row error tests must be able to rule out.
const BODYWEIGHT_ID = "01900000-0000-7000-8000-0000000000ab";
const HABIT_ID = "01900000-0000-7000-8000-0000000000cd";
const bodyweight = row({
	id: BODYWEIGHT_ID,
	occurred_at: "2026-06-10T07:00:00",
	schema_key: "bodyweight",
	values: { kg: 72.4 },
	source: { relation: "created_from", source_entity_id: "je-1" },
});
const habit = row({
	id: HABIT_ID,
	occurred_at: "2026-06-10T08:00:00",
	schema_key: "habit.checkin",
	values: { habit_id: "abcd1234-5678-9012-3456-7890abcdef00", state: "done" },
});
const unknown = row({
	id: "un",
	occurred_at: "2026-06-09T08:00:00",
	schema_key: "sleep.session",
	values: { hours: 7 },
});

const ALL = [bodyweight, habit, unknown];

/** Drives the controlled HealthView; clicking a chip flips `filter` locally. */
function Stateful({ initial }: { initial?: HealthFilter }) {
	const [filter, setFilter] = useState<HealthFilter>(initial);
	return <HealthView filter={filter} onFilterChange={setFilter} />;
}

/** One recorded `observation/update` call plus the resolver for its pending save,
 * so a test can leave a save in flight while the user moves on. */
interface Correction {
	readonly params: ObservationUpdateParams;
	readonly settle: (outcome: "ok" | "fail") => void;
}

/** Render `ui` over a stubbed Core: `observation/query` serves `rows` (or fails
 * when `failRead`), and every `observation/update` is recorded. A save stays
 * PENDING until the test settles it, which is what makes the switch-rows-mid-save
 * cases observable. */
async function renderHealth(
	ui: React.ReactElement,
	opts: { rows?: readonly ObservationRow[]; failRead?: boolean } = {},
) {
	const corrections: Correction[] = [];
	const result = await renderWithCore(ui, {
		overrides: {
			observationQuery: () =>
				opts.failRead === true
					? Effect.fail(new WsRequestError({ reason: "connection_lost" }))
					: Effect.succeed({ observations: opts.rows ?? [] }),
			observationUpdate: (params) =>
				Effect.async((resume) => {
					corrections.push({
						params,
						settle: (outcome) =>
							resume(
								outcome === "ok"
									? Effect.succeed({ observation_id: params.observation_id })
									: Effect.fail(
											new WsRequestError({ reason: "server_rejected" }),
										),
							),
					});
				}),
		},
	});
	return { ...result, corrections };
}

/** The rows' Correct buttons, in render order. */
const correctButtons = () =>
	screen.getAllByRole("button", { name: /^correct$/i });

/** The open correction editor's values textarea. */
const valuesEditor = () =>
	screen.getByLabelText<HTMLTextAreaElement>(/^values$/i);

describe("HealthView", () => {
	it("renders day group headers, newest day first", async () => {
		await renderHealth(<Stateful />, { rows: ALL });
		const headers = await screen.findAllByRole("heading", { level: 2 });
		expect(headers.length).toBe(2);
		// Two distinct days; newest (06-10) heads the list.
		expect(headers[0]?.textContent).not.toBe(headers[1]?.textContent);
	});

	it("polishes a known schema and falls back to raw key + JSON for unknown", async () => {
		await renderHealth(<Stateful />, { rows: ALL });
		// Polished bodyweight summary (also echoed in its Weight field row, so the
		// text legitimately appears more than once — assert presence, not uniqueness).
		expect((await screen.findAllByText("72.4 kg")).length).toBeGreaterThan(0);
		// Unknown schema degrades to raw key + JSON, no crash.
		expect(screen.getByText("sleep.session")).toBeInTheDocument();
		expect(screen.getByText('{"hours":7}')).toBeInTheDocument();
	});

	it("offers an All chip plus one chip per known schema present", async () => {
		await renderHealth(<Stateful />, { rows: ALL });
		// The bodyweight chip only appears once the rows land, so await it first.
		expect(
			await screen.findByRole("button", { name: /bodyweight/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^all/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /habits/i })).toBeInTheDocument();
	});

	it("clicking a schema chip narrows the stream to that schema", async () => {
		await renderHealth(<Stateful />, { rows: ALL });
		// Under All, both the bodyweight and the habit row render.
		expect((await screen.findAllByText("72.4 kg")).length).toBeGreaterThan(0);
		expect(screen.getByText(/Habit ·/)).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /bodyweight/i }));

		// Only bodyweight survives the filter.
		expect(screen.getAllByText("72.4 kg").length).toBeGreaterThan(0);
		expect(screen.queryByText(/Habit ·/)).not.toBeInTheDocument();
	});

	it("renders only the bodyweight stream when controlled with filter=bodyweight", async () => {
		await renderHealth(
			<HealthView filter="bodyweight" onFilterChange={() => {}} />,
			{ rows: ALL },
		);
		expect((await screen.findAllByText("72.4 kg")).length).toBeGreaterThan(0);
		expect(screen.queryByText(/Habit ·/)).not.toBeInTheDocument();
		expect(screen.queryByText("sleep.session")).not.toBeInTheDocument();
	});

	it("calls onFilterChange with the schema key when a chip is clicked", async () => {
		const onFilterChange = vi.fn();
		await renderHealth(
			<HealthView filter={undefined} onFilterChange={onFilterChange} />,
			{ rows: ALL },
		);
		await userEvent.click(
			await screen.findByRole("button", { name: /habits/i }),
		);
		expect(onFilterChange).toHaveBeenCalledWith("habit.checkin");
	});

	it("shows 'Captured from' exactly once — only for the sourced row", async () => {
		await renderHealth(<Stateful />, { rows: ALL });
		expect(await screen.findAllByText(/captured from/i)).toHaveLength(1);
		expect(
			screen.getByText(/captured from a journal entry/i),
		).toBeInTheDocument();
	});

	it("labels an evidenced_by (message) source as 'Captured from a message'", async () => {
		await renderHealth(<Stateful />, {
			rows: [
				row({
					id: "msg",
					schema_key: "bodyweight",
					values: { kg: 70 },
					source: { relation: "evidenced_by", source_message_id: "m-1" },
				}),
			],
		});
		expect(
			await screen.findByText(/captured from a message/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/captured from a journal entry/i),
		).not.toBeInTheDocument();
	});

	it("renders the plain empty state when there are no observations", async () => {
		await renderHealth(<Stateful />, { rows: [] });
		expect(await screen.findByText(/no observations yet/i)).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load health/i)).not.toBeInTheDocument();
	});

	it("keeps the active filter chip and shows filter-specific empty copy when the filter matches nothing", async () => {
		// Route-controlled filter on a schema with zero rows (e.g. a bookmarked
		// `?schema=habit.checkin` while only bodyweight exists): the chip must stay
		// visible to clear, and the empty copy must not claim the workspace is empty.
		await renderHealth(
			<HealthView filter="habit.checkin" onFilterChange={() => {}} />,
			{ rows: [bodyweight] }, // only a bodyweight row exists
		);
		expect(
			await screen.findByText(/no habits observations yet/i),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /habits/i })).toBeInTheDocument();
		expect(screen.queryByText(/^no observations yet/i)).not.toBeInTheDocument();
	});

	it("renders the danger empty state on read error", async () => {
		await renderHealth(<Stateful />, { failRead: true });
		expect(
			await screen.findByText(/couldn't load health/i),
		).toBeInTheDocument();
	});

	describe("correction flow", () => {
		it("opens a form pre-filled with the row's current occurred_at + values", async () => {
			await renderHealth(<Stateful />, { rows: ALL });
			// One Correct button per row; click the bodyweight row's.
			const corrects = await screen.findAllByRole("button", {
				name: /^correct$/i,
			});
			expect(corrects.length).toBe(ALL.length);
			await userEvent.click(corrects[0]);

			// occurred_at seeded from the stored wall-clock string (with seconds).
			expect(
				screen.getByDisplayValue("2026-06-10T07:00:00"),
			).toBeInTheDocument();
			// values textarea pre-filled with the row's current values (pretty JSON).
			expect(valuesEditor().value).toContain('"kg": 72.4');
		});

		it("submits a SOURCE-FREE full-replacement draft (no schema_key, no source)", async () => {
			const { corrections } = await renderHealth(<Stateful />, { rows: ALL });
			await userEvent.click((await correctButtonsReady())[0]);

			// Edit the values (change kg) then save. `paste` sets the textarea verbatim
			// — `type` would interpret JSON braces/brackets as userEvent key syntax.
			const valuesField = valuesEditor();
			await userEvent.clear(valuesField);
			valuesField.focus();
			await userEvent.paste('{"kg": 73.1}');
			await userEvent.click(
				screen.getByRole("button", { name: /save correction/i }),
			);

			expect(corrections).toHaveLength(1);
			const params = corrections[0].params;
			expect(params.observation_id).toBe(BODYWEIGHT_ID);
			expect(params.observation.occurred_at).toBe("2026-06-10T07:00:00");
			expect(params.observation.values).toEqual({ kg: 73.1 });
			// Source-free full replacement: provenance fields never reach the wire.
			expect("schema_key" in params.observation).toBe(false);
			expect("source" in params.observation).toBe(false);
		});

		it("leaves the 'Captured from' provenance line unchanged while correcting", async () => {
			await renderHealth(<Stateful />, { rows: ALL });
			expect(
				await screen.findByText(/captured from a journal entry/i),
			).toBeInTheDocument();
			await userEvent.click((await correctButtonsReady())[0]);
			// Provenance is immutable + display-only — still present with the editor open.
			expect(
				screen.getByText(/captured from a journal entry/i),
			).toBeInTheDocument();
		});

		it("keeps a single active editor — opening Correct on one row doesn't open another", async () => {
			await renderHealth(<Stateful />, { rows: ALL });
			const corrects = await correctButtonsReady();
			await userEvent.click(corrects[0]);
			expect(screen.getAllByLabelText(/^values$/i).length).toBe(1);
			await userEvent.click(corrects[1]);
			// Still exactly one open editor (the second row's), not two.
			expect(screen.getAllByLabelText(/^values$/i).length).toBe(1);
		});

		it("resets the shared mutation on open/switch/cancel so no stale error bleeds into a fresh editor", async () => {
			const { corrections } = await renderHealth(<Stateful />, { rows: ALL });
			// A prior save that FAILED leaves the shared mutation holding an error.
			await userEvent.click((await correctButtonsReady())[0]);
			await userEvent.click(
				screen.getByRole("button", { name: /save correction/i }),
			);
			await act(async () => {
				corrections[0].settle("fail");
			});
			expect(await screen.findByRole("alert")).toBeInTheDocument();

			// Cancel, then re-open the SAME row: the editor resets on open, so the
			// fresh form shows no stale error.
			await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
			await userEvent.click(correctButtons()[0]);
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();

			// Switching STRAIGHT to another row resets too. With row A's form open the
			// remaining Correct buttons are the other rows, and the next in day order
			// is the habit row.
			await userEvent.click(correctButtons()[0]);
			expect(valuesEditor().value).toContain("habit_id");
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		});

		it("a slow save resolving after the user switched rows does not close the new editor", async () => {
			const { corrections } = await renderHealth(<Stateful />, { rows: ALL });
			// Open + submit row A (bodyweight); its save stays pending.
			await userEvent.click((await correctButtonsReady())[0]);
			await userEvent.click(
				screen.getByRole("button", { name: /save correction/i }),
			);
			expect(corrections).toHaveLength(1);
			// The user opens a different row before A's save returns (with A's form
			// open, the remaining Correct buttons are the other rows). The next row in
			// day order is the habit row — assert ITS editor is the one now open.
			await userEvent.click(correctButtons()[0]);
			expect(valuesEditor().value).toContain("habit_id");
			// Now A's save resolves — it must NOT close the switched-to (habit) editor.
			await act(async () => {
				corrections[0].settle("ok");
			});
			expect(valuesEditor().value).toContain("habit_id");
		});

		it("a slow save FAILING after the user switched rows does not surface its error in the new editor", async () => {
			const { corrections } = await renderHealth(<Stateful />, { rows: ALL });
			// Open + submit row A (bodyweight) — this stamps it as the correcting row.
			await userEvent.click((await correctButtonsReady())[0]);
			await userEvent.click(
				screen.getByRole("button", { name: /save correction/i }),
			);
			// Switch to the habit row before A's save settles.
			await userEvent.click(correctButtons()[0]);
			expect(valuesEditor().value).toContain("habit_id");
			// A's save now FAILS: the shared mutation holds A's error, but it must NOT
			// bleed into the open habit editor (it's scoped to the correcting row).
			await act(async () => {
				corrections[0].settle("fail");
			});
			expect(valuesEditor().value).toContain("habit_id");
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		});
	});
});

/** The rows' Correct buttons once the stream has painted. */
async function correctButtonsReady() {
	return screen.findAllByRole("button", { name: /^correct$/i });
}
