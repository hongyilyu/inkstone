import type { TickTickTaskRow } from "@inkstone/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { TasksView, type TasksViewProps } from "@/components/library/TasksView";

afterEach(cleanup);

function row(
	partial: Partial<TickTickTaskRow> & { id: string },
): TickTickTaskRow {
	return {
		title: "a task",
		kind: "TEXT",
		priority: 0,
		tags: [],
		checklist_items: [],
		...partial,
	};
}

function view(overrides: Partial<TasksViewProps> = {}): TasksViewProps {
	return {
		connected: true,
		statusResolved: true,
		statusError: false,
		rows: [],
		sourceLimitReached: false,
		tasksInitialError: false,
		tasksStaleError: false,
		tasksLoading: false,
		refresh: () => {},
		refreshing: false,
		...overrides,
	};
}

describe("TasksView", () => {
	it("shows the not-connected notice when status resolved disconnected", () => {
		render(<TasksView {...view({ connected: false })} />);
		expect(screen.getByTestId("ticktick-disconnected")).toBeInTheDocument();
	});

	it("shows the error state on a status-read failure (not 'No tasks.')", () => {
		render(
			<TasksView {...view({ statusResolved: false, statusError: true })} />,
		);
		expect(screen.getByTestId("ticktick-error")).toBeInTheDocument();
		expect(screen.queryByText("No tasks.")).toBeNull();
	});

	it("an INITIAL task failure (no rows) shows the error state", () => {
		render(<TasksView {...view({ tasksInitialError: true })} />);
		expect(screen.getByTestId("ticktick-error")).toBeInTheDocument();
	});

	it("offers a manual refresh that fires the command (A2, review R12 #4)", async () => {
		let refreshed = 0;
		render(
			<TasksView
				{...view({
					rows: [row({ id: "t1" })],
					refresh: () => {
						refreshed += 1;
					},
				})}
			/>,
		);
		await userEvent.click(screen.getByTestId("ticktick-refresh"));
		expect(refreshed).toBe(1);
	});

	it("disables the refresh control while a refresh is in flight", () => {
		render(
			<TasksView {...view({ rows: [row({ id: "t1" })], refreshing: true })} />,
		);
		expect(screen.getByTestId("ticktick-refresh")).toBeDisabled();
	});

	it("the error states offer a Retry that fires the refresh command", async () => {
		let refreshed = 0;
		render(
			<TasksView
				{...view({
					tasksInitialError: true,
					refresh: () => {
						refreshed += 1;
					},
				})}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(refreshed).toBe(1);
	});

	it("shows loading (never a false 'No tasks.') while the status read is pending", () => {
		// The first status fetch is in flight: not resolved, not connected, no rows,
		// no task-loading flag yet (the task read is still gated) — review M5.
		render(
			<TasksView {...view({ statusResolved: false, connected: false })} />,
		);
		expect(screen.getByText("Loading tasks…")).toBeInTheDocument();
		expect(screen.queryByText("No tasks.")).toBeNull();
	});

	it("a STALE refetch failure keeps the last-good rows with a stale indicator", () => {
		render(
			<TasksView
				{...view({
					rows: [row({ id: "t1", title: "buy milk" })],
					tasksStaleError: true,
				})}
			/>,
		);
		// The rows survive a failed background refetch (A2 failure semantics)…
		expect(screen.getByTestId("ticktick-task")).toHaveTextContent("buy milk");
		// …with a stale indicator, NOT the full error screen.
		expect(screen.getByTestId("ticktick-stale-warning")).toBeInTheDocument();
		expect(screen.queryByTestId("ticktick-error")).toBeNull();
	});

	it("renders the truncation warning ONLY when the source limit was reached", () => {
		const { rerender } = render(
			<TasksView {...view({ rows: [row({ id: "t1" })] })} />,
		);
		expect(screen.queryByTestId("ticktick-truncation-warning")).toBeNull();

		rerender(
			<TasksView
				{...view({ rows: [row({ id: "t1" })], sourceLimitReached: true })}
			/>,
		);
		expect(screen.getByTestId("ticktick-truncation-warning")).toHaveTextContent(
			"200-item limit",
		);
	});

	it("renders one row per task, with an unmatched list shown as 'unnamed list'", () => {
		render(
			<TasksView
				{...view({
					rows: [
						row({ id: "t1", title: "buy milk", list_name: "Inbox" }),
						row({ id: "t2", title: "think", list_name: undefined }),
					],
				})}
			/>,
		);
		const rows = screen.getAllByTestId("ticktick-task");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveTextContent("buy milk");
		expect(rows[0]).toHaveTextContent("Inbox");
		expect(rows[1]).toHaveTextContent("unnamed list");
	});

	it("filters LOCALLY by title over the one fetched result (A2 display-only filtering)", async () => {
		const user = userEvent.setup();
		render(
			<TasksView
				{...view({
					rows: [
						row({ id: "t1", title: "buy milk" }),
						row({ id: "t2", title: "call the vet" }),
					],
				})}
			/>,
		);
		expect(screen.getAllByTestId("ticktick-task")).toHaveLength(2);
		await user.type(
			screen.getByRole("searchbox", { name: /filter tasks/i }),
			"milk",
		);
		const rows = screen.getAllByTestId("ticktick-task");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveTextContent("buy milk");
	});

	it("renders an all-day due in its own timezone, not UTC (Asia/Shanghai regression)", () => {
		// An all-day 2026-08-20 in Asia/Shanghai (+8) is stored as the UTC instant
		// of local midnight: 2026-08-19T16:00:00Z. Formatting in UTC would show
		// Aug 19 (the previous day); the local zone must show Aug 20.
		const date = "2026-08-19T16:00:00.000+0000";
		render(
			<TasksView
				{...view({
					rows: [
						row({
							id: "t1",
							title: "all day",
							due: { date, is_all_day: true, time_zone: "Asia/Shanghai" },
						}),
					],
				})}
			/>,
		);
		const rowText = screen.getByTestId("ticktick-task").textContent ?? "";
		const shanghai = new Date(date).toLocaleDateString(undefined, {
			timeZone: "Asia/Shanghai",
		});
		const utc = new Date(date).toLocaleDateString(undefined, {
			timeZone: "UTC",
		});
		expect(shanghai).not.toBe(utc); // the two zones disagree on the calendar day
		expect(rowText).toContain(shanghai);
		expect(rowText).not.toContain(utc);
	});

	it("shows a checklist progress count", () => {
		render(
			<TasksView
				{...view({
					rows: [
						row({
							id: "t1",
							title: "groceries",
							kind: "CHECKLIST",
							checklist_items: [
								{ title: "milk", done: true },
								{ title: "eggs", done: false },
							],
						}),
					],
				})}
			/>,
		);
		expect(screen.getByTestId("ticktick-task")).toHaveTextContent("1/2");
	});
});
