import type { EntityListResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { ProjectReviewView } from "./ProjectReviewView";

type Rows = EntityListResult["entities"];

function makeRuntime(projects: Rows, todos: Rows = [], people: Rows = []) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		threadGet: () => unused,
		listEntities: (type) => {
			if (type === "project") return Effect.succeed({ entities: projects });
			if (type === "todo") return Effect.succeed({ entities: todos });
			if (type === "person") return Effect.succeed({ entities: people });
			return Effect.succeed({ entities: [] });
		},
		subscribeRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		proposalDecide: () => unused,
		proposalNotifications: () => unused,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

function renderReview(projects: Rows, todos: Rows = [], people: Rows = []) {
	const runtime = makeRuntime(projects, todos, people);
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
	return render(<ProjectReviewView selectedId={null} onSelect={() => {}} />, {
		wrapper: Wrapper,
	});
}

const project = (
	id: string,
	name: string,
	data: Record<string, unknown>,
): Rows[number] => ({
	id,
	type: "project",
	data: { name, status: "active", ...data },
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
});

// Past = unambiguously due regardless of real "now"; far future = never due.
const PAST = "2000-01-01T20:00:00";
const FUTURE = "2999-01-01T20:00:00";

afterEach(cleanup);

describe("ProjectReviewView", () => {
	it("lists active/on_hold projects whose review is due, excludes future/terminal", async () => {
		renderReview([
			project("p_active", "Active due", {
				status: "active",
				next_review_at: PAST,
			}),
			project("p_hold", "On hold due", {
				status: "on_hold",
				next_review_at: PAST,
			}),
			project("p_future", "Not yet due", {
				status: "active",
				next_review_at: FUTURE,
			}),
			project("p_done", "Completed", {
				status: "completed",
				next_review_at: PAST,
			}),
			project("p_dropped", "Dropped", {
				status: "dropped",
				next_review_at: PAST,
			}),
		]);

		expect(await screen.findByText("Active due")).toBeInTheDocument();
		expect(screen.getByText("On hold due")).toBeInTheDocument();
		expect(screen.queryByText("Not yet due")).not.toBeInTheDocument();
		expect(screen.queryByText("Completed")).not.toBeInTheDocument();
		expect(screen.queryByText("Dropped")).not.toBeInTheDocument();
	});

	it("shows whether a due project has active todos", async () => {
		renderReview(
			[project("p1", "API migration", { next_review_at: PAST })],
			[
				{
					id: "t1",
					type: "todo",
					data: { title: "do it", status: "active", project_id: "p1" },
					created_at: 1,
					updated_at: 1,
				},
			],
		);
		expect(await screen.findByText("API migration")).toBeInTheDocument();
		expect(screen.getByText("Has active todos")).toBeInTheDocument();
	});

	it("teaches the empty state when nothing is due", async () => {
		renderReview([project("p_future", "Later", { next_review_at: FUTURE })]);
		expect(await screen.findByText("All caught up")).toBeInTheDocument();
	});
});
