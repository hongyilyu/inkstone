import type { EntityListResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Hourglass, Inbox } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { inboxTodos, waitingTodos } from "@/lib/libraryItems";
import { RuntimeProvider } from "@/runtime";
import { DerivedTodoView } from "./DerivedTodoView";

type Rows = EntityListResult["entities"];

/** Stub WsClient serving the given entity rows by type; unused methods die. */
function makeRuntime(todos: Rows, people: Rows = [], projects: Rows = []) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory: () => unused,
		threadGet: () => unused,
		listEntities: (type) => {
			if (type === "todo") return Effect.succeed({ entities: todos });
			if (type === "person") return Effect.succeed({ entities: people });
			if (type === "project") return Effect.succeed({ entities: projects });
			return Effect.succeed({ entities: [] });
		},
		getBacklinks: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		rescanJournalEntry: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => unused,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

function renderWithTodos(
	todos: Rows,
	view: Pick<
		ComponentProps<typeof DerivedTodoView>,
		"title" | "intro" | "icon" | "select" | "emptyTitle" | "emptyDescription"
	>,
) {
	const runtime = makeRuntime(todos);
	const client = new QueryClient({
		defaultOptions: {
			queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
		},
	});
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
	return render(
		<DerivedTodoView {...view} selectedId={null} onSelect={() => {}} />,
		{ wrapper: Wrapper },
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

const todo = (
	id: string,
	title: string,
	data: Record<string, unknown>,
): Rows[number] => ({
	id,
	type: "todo",
	data: { title, status: "active", ...data },
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

afterEach(cleanup);

describe("DerivedTodoView — Inbox", () => {
	it("renders unorganized active todos and excludes organized ones", async () => {
		renderInbox([
			todo("t_inbox", "Buy milk", {}),
			todo("t_project", "Has a project", { project_id: "proj_1" }),
			todo("t_due", "Has a due date", { due_at: "2026-06-20T00:00:00" }),
		]);

		expect(await screen.findByText("Buy milk")).toBeInTheDocument();
		expect(screen.queryByText("Has a project")).not.toBeInTheDocument();
		expect(screen.queryByText("Has a due date")).not.toBeInTheDocument();
	});

	it("excludes a todo carrying a person_ref", async () => {
		renderInbox([
			todo("t_inbox", "Lonely todo", {}),
			{
				id: "t_ref",
				type: "todo",
				data: { title: "Waiting on Alice", status: "active" },
				person_refs: [{ person_id: "alice", role: "waiting_on" }],
				created_at: 1_700_000_000_000,
				updated_at: 1_700_000_000_000,
			},
		]);

		expect(await screen.findByText("Lonely todo")).toBeInTheDocument();
		expect(screen.queryByText("Waiting on Alice")).not.toBeInTheDocument();
	});

	it("teaches the empty state when nothing is unsorted", async () => {
		renderInbox([todo("t_project", "Organized", { project_id: "proj_1" })]);
		expect(await screen.findByText("Inbox zero")).toBeInTheDocument();
	});
});

const todoWithRefs = (
	id: string,
	title: string,
	refs: { person_id: string; role: "waiting_on" | "related" }[],
	data: Record<string, unknown> = {},
): Rows[number] => ({
	id,
	type: "todo",
	data: { title, status: "active", ...data },
	person_refs: refs,
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

describe("DerivedTodoView — Waiting", () => {
	it("renders todos waiting on someone, excludes related-only", async () => {
		renderWaiting([
			todoWithRefs("t_wait", "Waiting on Priya", [
				{ person_id: "priya", role: "waiting_on" },
			]),
			todoWithRefs("t_related", "Just related to Bob", [
				{ person_id: "bob", role: "related" },
			]),
		]);

		expect(await screen.findByText("Waiting on Priya")).toBeInTheDocument();
		expect(screen.queryByText("Just related to Bob")).not.toBeInTheDocument();
	});

	it("teaches the empty state when nothing is pending", async () => {
		renderWaiting([
			todoWithRefs("t_related", "Related only", [
				{ person_id: "bob", role: "related" },
			]),
		]);
		expect(await screen.findByText("Nothing pending")).toBeInTheDocument();
	});
});
