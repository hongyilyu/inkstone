import type { EntityListResult } from "@inkstone/protocol";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { todoRow } from "@test/test-utils/rows";
import { cleanup, screen } from "@testing-library/react";
import { Hourglass, Inbox } from "lucide-react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DerivedTodoView } from "@/components/library/DerivedTodoView";
import { inboxTodos, waitingTodos } from "@/lib/libraryItems";

type Rows = EntityListResult["entities"];

function renderWithTodos(
	todos: Rows,
	view: Pick<
		ComponentProps<typeof DerivedTodoView>,
		"title" | "intro" | "icon" | "select" | "emptyTitle" | "emptyDescription"
	>,
) {
	return renderWithCore(
		<DerivedTodoView {...view} selectedId={null} onSelect={() => {}} />,
		{ entities: { todo: todos } },
	);
}

const INBOX_VIEW = {
	title: "Inbox",
	intro: "Unorganized active todos.",
	icon: Inbox,
	select: inboxTodos,
	emptyTitle: "Inbox zero",
	emptyDescription: "Nothing unsorted.",
};

const WAITING_VIEW = {
	title: "Waiting",
	intro: "Waiting on someone.",
	icon: Hourglass,
	select: waitingTodos,
	emptyTitle: "Nothing pending",
	emptyDescription: "No follow-ups.",
};

const renderInbox = (todos: Rows) => renderWithTodos(todos, INBOX_VIEW);
const renderWaiting = (todos: Rows) => renderWithTodos(todos, WAITING_VIEW);

afterEach(cleanup);

describe("DerivedTodoView — Inbox", () => {
	it("renders unorganized active todos and excludes organized ones", async () => {
		renderInbox([
			todoRow("t_inbox", "Buy milk", {}),
			todoRow("t_project", "Has a project", { project_id: "proj_1" }),
			todoRow("t_due", "Has a due date", { due_at: "2026-06-20T00:00:00" }),
		]);

		expect(await screen.findByText("Buy milk")).toBeInTheDocument();
		expect(screen.queryByText("Has a project")).not.toBeInTheDocument();
		expect(screen.queryByText("Has a due date")).not.toBeInTheDocument();
	});

	it("excludes a todo carrying a person_ref", async () => {
		renderInbox([
			todoRow("t_inbox", "Lonely todo", {}),
			todoRow(
				"t_ref",
				"Waiting on Alice",
				{},
				{
					person_refs: [{ person_id: "alice", role: "waiting_on" }],
				},
			),
		]);

		expect(await screen.findByText("Lonely todo")).toBeInTheDocument();
		expect(screen.queryByText("Waiting on Alice")).not.toBeInTheDocument();
	});

	it("teaches the empty state when nothing is unsorted", async () => {
		renderInbox([todoRow("t_project", "Organized", { project_id: "proj_1" })]);
		expect(await screen.findByText("Inbox zero")).toBeInTheDocument();
	});
});

describe("DerivedTodoView — Waiting", () => {
	it("renders todos waiting on someone, excludes related-only", async () => {
		renderWaiting([
			todoRow(
				"t_wait",
				"Waiting on Priya",
				{},
				{
					person_refs: [{ person_id: "priya", role: "waiting_on" }],
				},
			),
			todoRow(
				"t_related",
				"Just related to Bob",
				{},
				{
					person_refs: [{ person_id: "bob", role: "related" }],
				},
			),
		]);

		expect(await screen.findByText("Waiting on Priya")).toBeInTheDocument();
		expect(screen.queryByText("Just related to Bob")).not.toBeInTheDocument();
	});

	it("teaches the empty state when nothing is pending", async () => {
		renderWaiting([
			todoRow(
				"t_related",
				"Related only",
				{},
				{
					person_refs: [{ person_id: "bob", role: "related" }],
				},
			),
		]);
		expect(await screen.findByText("Nothing pending")).toBeInTheDocument();
	});
});
