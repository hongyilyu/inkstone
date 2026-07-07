import type { EntityListResult } from "@inkstone/protocol";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { projectRow, todoRow } from "@test/test-utils/rows";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { type GtdFilter, GtdView } from "@/components/library/GtdView";

type Rows = EntityListResult["entities"];

/** A tiny stateful wrapper that drives the controlled GtdView: clicking a pill
 * flips `filt` locally, so the test exercises the rail without a router. */
function StatefulGtd({
	initial = "today" as GtdFilter,
}: {
	initial?: GtdFilter;
}) {
	const [filt, setFilt] = useState<GtdFilter>(initial);
	return (
		<GtdView
			filt={filt}
			onFilterChange={setFilt}
			selectedId={null}
			onSelect={() => {}}
		/>
	);
}

function renderGtd(
	todos: Rows,
	projects: Rows = [],
	people: Rows = [],
	initial: GtdFilter = "today",
) {
	return renderWithCore(<StatefulGtd initial={initial} />, {
		entities: { todo: todos, project: projects, person: people },
	});
}

// Deep past = unambiguously due regardless of the real "now".
const PAST = "2000-01-01T00:00:00";
// Far future = a defer date that never arrives.
const FUTURE = "2999-01-01T00:00:00";

afterEach(cleanup);

describe("GtdView", () => {
	it("renders the seven filter pills", async () => {
		renderGtd([]);
		// Filter pills are toggle buttons (aria-pressed), not ARIA tabs — a tablist
		// without roving focus/aria-controls would be a broken tab contract.
		await screen.findByRole("button", { name: /today/i });
		for (const label of [
			/^inbox$/i,
			/waiting/i,
			/scheduled/i,
			/review/i,
			/projects/i,
			/^all$/i,
		]) {
			expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
		}
	});

	it("defaults to the Today body (due-soon todos)", async () => {
		renderGtd([
			todoRow("t_due", "Pay rent", { due_at: PAST }),
			todoRow("t_inbox", "Unsorted errand"),
		]);
		// Today surfaces due-soon todos; the unsorted inbox-only todo is not due.
		expect(await screen.findByText("Pay rent")).toBeInTheDocument();
		expect(screen.queryByText("Unsorted errand")).not.toBeInTheDocument();
	});

	it("swaps to the Waiting body when the Waiting pill is clicked", async () => {
		renderGtd([
			todoRow("t_inbox", "Unsorted errand"),
			todoRow(
				"t_wait",
				"Waiting on Priya",
				{},
				{
					person_refs: [{ person_id: "priya", role: "waiting_on" }],
				},
			),
		]);
		await screen.findByRole("button", { name: /waiting/i });
		await userEvent.click(screen.getByRole("button", { name: /waiting/i }));

		expect(await screen.findByText("Waiting on Priya")).toBeInTheDocument();
		expect(screen.queryByText("Unsorted errand")).not.toBeInTheDocument();
	});

	it("shows the Inbox todo under the Inbox pill, hides organized ones", async () => {
		renderGtd([
			todoRow("t_inbox", "Unsorted errand"),
			// Organized (has a project) → not inbox-eligible, and it carries a future
			// defer date so it also proves the deferred-todo seed lands on Scheduled.
			todoRow("t_deferred", "Future deferred", {
				defer_at: FUTURE,
				project_id: "p1",
			}),
		]);
		await userEvent.click(
			await screen.findByRole("button", { name: /^inbox$/i }),
		);

		expect(await screen.findByText("Unsorted errand")).toBeInTheDocument();
		expect(screen.queryByText("Future deferred")).not.toBeInTheDocument();
	});

	it("shows the future-deferred todo under the Scheduled pill", async () => {
		renderGtd([
			todoRow("t_inbox", "Unsorted errand"),
			todoRow("t_deferred", "Future deferred", {
				defer_at: FUTURE,
				project_id: "p1",
			}),
		]);
		await userEvent.click(
			await screen.findByRole("button", { name: /scheduled/i }),
		);

		expect(await screen.findByText("Future deferred")).toBeInTheDocument();
		expect(screen.queryByText("Unsorted errand")).not.toBeInTheDocument();
	});

	it("shows the reviewable project when the Review pill is clicked", async () => {
		renderGtd(
			[todoRow("t_inbox", "Unsorted errand")],
			[projectRow("p_review", "Quarterly planning", { next_review_at: PAST })],
		);
		await userEvent.click(
			await screen.findByRole("button", { name: /review/i }),
		);

		expect(await screen.findByText("Quarterly planning")).toBeInTheDocument();
		expect(screen.queryByText("Unsorted errand")).not.toBeInTheDocument();
	});

	it("shows projects under the Projects pill (the full project list, not just reviewable)", async () => {
		// A project with no next_review_at — it's NOT reviewable, so this proves the
		// Projects body lists every project (matching the badge count, which counts
		// all projects regardless of status/review state).
		renderGtd(
			[todoRow("t_inbox", "Unsorted errand")],
			[projectRow("p_active", "Marketing launch")],
		);
		await userEvent.click(
			await screen.findByRole("button", { name: /^projects$/i }),
		);

		expect(await screen.findByText("Marketing launch")).toBeInTheDocument();
		expect(screen.queryByText("Unsorted errand")).not.toBeInTheDocument();
	});

	it("shows every active todo under the All pill, not just the inbox subset", async () => {
		// Two active todos: one inbox-eligible (bare), one organized (project + due) so
		// it is NOT in inboxTodos. "All" must show BOTH todo titles — which makes the
		// case load-bearing two ways: wiring All to inboxTodos would drop the organized
		// one, and wiring it to the Projects/EntityCollection body would render project
		// rows (never todo titles), so neither title would appear.
		renderGtd(
			[
				todoRow("t_inbox", "Unsorted errand"),
				todoRow("t_org", "Cut over traffic", {
					project_id: "p1",
					due_at: PAST,
				}),
			],
			[projectRow("p1", "Migration", { next_review_at: FUTURE })],
		);
		await userEvent.click(
			await screen.findByRole("button", { name: /^all$/i }),
		);

		expect(await screen.findByText("Unsorted errand")).toBeInTheDocument();
		expect(screen.getByText("Cut over traffic")).toBeInTheDocument();
	});
});
