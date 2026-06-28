import type { RunHistoryItem, RunHistoryResult } from "@inkstone/protocol";
import { WsClient, type WsError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { RunFeed } from "./RunFeed";

/** Stub WsClient whose `getRunHistory` runs the provided handler; others die. */
function makeRuntime(
	getRunHistory: () => Effect.Effect<RunHistoryResult, WsError>,
) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory,
		recurrencePreview: () => unused,
		threadGet: () => unused,
		threadRename: () => unused,
		threadArchive: () => unused,
		threadUnarchive: () => unused,
		threadListArchived: () => unused,
		listEntities: () => unused,
		getBacklinks: () => unused,
		observationQuery: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		retryRun: () => unused,
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
		connectionStatus: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

function renderFeed(
	getRunHistory: () => Effect.Effect<RunHistoryResult, WsError>,
	onOpenThread: (id: string) => void = () => {},
) {
	const runtime = makeRuntime(getRunHistory);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
	return render(<RunFeed onOpenThread={onOpenThread} />, { wrapper: Wrapper });
}

// A fixed "now" (noon local) so recency buckets don't flake around midnight.
// The system clock is pinned to it (below) so the component's internal
// `Date.now()` and the row timestamps agree.
const TODAY = new Date(2026, 5, 16, 12, 0, 0).getTime();
const item = (over: Partial<RunHistoryItem>): RunHistoryItem => ({
	run_id: "r1",
	thread_id: "t1",
	title: "A run",
	kind: "done",
	at: TODAY,
	...over,
});

describe("RunFeed", () => {
	// Pin Date.now() to TODAY; keep timers otherwise real (userEvent needs them).
	beforeEach(() => {
		vi.useFakeTimers({
			now: TODAY,
			toFake: ["Date"],
			shouldAdvanceTime: true,
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		cleanup();
	});

	it("renders live history grouped by recency with per-kind labels", async () => {
		const runs: RunHistoryItem[] = [
			item({
				run_id: "r1",
				thread_id: "t1",
				title: "Newest run",
				kind: "done",
			}),
			item({
				run_id: "r2",
				thread_id: "t2",
				title: "Resumed run",
				kind: "proposal_decided",
			}),
			item({
				run_id: "r3",
				thread_id: "t3",
				title: "Failed run",
				kind: "error",
			}),
			item({
				run_id: "r4",
				thread_id: "t4",
				title: "Old waiting run",
				kind: "proposal_pending",
				at: TODAY - 10 * 86_400_000, // > a week ago → "Older"
			}),
		];

		renderFeed(() => Effect.succeed({ runs }));

		// Titles render once the read resolves.
		expect(await screen.findByText("Newest run")).toBeInTheDocument();

		// Per-kind labels from the presentation map.
		expect(screen.getByText(/Done ·/)).toBeInTheDocument();
		expect(screen.getByText(/Running, resumed ·/)).toBeInTheDocument();
		expect(screen.getByText(/Failed ·/)).toBeInTheDocument();
		expect(screen.getByText(/Waiting ·/)).toBeInTheDocument();

		// Recency grouping: rows land under the RIGHT section header, not merely
		// that both headers exist (a misbucketing regression would still render
		// both headers). Scope each title to its section.
		const sectionFor = (label: string): HTMLElement => {
			const section = screen.getByText(label).closest("section");
			if (section === null) throw new Error(`no <section> for "${label}"`);
			return section as HTMLElement;
		};
		const todaySection = sectionFor("Today");
		const olderSection = sectionFor("Older");
		expect(within(todaySection).getByText("Newest run")).toBeInTheDocument();
		expect(
			within(olderSection).getByText("Old waiting run"),
		).toBeInTheDocument();
		// The 10-day-old row must NOT appear under Today.
		expect(within(todaySection).queryByText("Old waiting run")).toBeNull();

		// Section order: Today precedes Older in the DOM.
		const headings = screen.getAllByRole("heading", { level: 2 });
		const labels = headings.map((h) => h.textContent);
		expect(labels.indexOf("Today")).toBeLessThan(labels.indexOf("Older"));
	});

	it("opens a run's thread when its row is clicked", async () => {
		const onOpenThread = vi.fn();
		renderFeed(
			() =>
				Effect.succeed({
					runs: [
						item({ run_id: "r1", thread_id: "thread-42", title: "Clickable" }),
					],
				}),
			onOpenThread,
		);

		const row = await screen.findByRole("button", { name: /Clickable/ });
		await userEvent.click(row);
		expect(onOpenThread).toHaveBeenCalledWith("thread-42");
	});

	it("shows a teaching empty state when there are no runs", async () => {
		renderFeed(() => Effect.succeed({ runs: [] }));
		expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();
		expect(screen.getByText(/appear here as you chat/i)).toBeInTheDocument();
	});

	it("shows a skeleton loading state before the read resolves", () => {
		// A read that never settles keeps the query pending.
		renderFeed(() =>
			Effect.async<RunHistoryResult, WsError>(() => {
				// never resume → the promise stays pending
			}),
		);
		// Skeleton placeholder shown, not the empty/error copy or a spinner.
		expect(screen.getByTestId("run-feed-skeleton")).toBeInTheDocument();
		expect(screen.queryByText(/no runs yet/i)).not.toBeInTheDocument();
		expect(
			screen.queryByText(/couldn't load run history/i),
		).not.toBeInTheDocument();
	});

	it("shows an error state with a working retry when Core is unreachable", async () => {
		let attempts = 0;
		renderFeed(() => {
			attempts += 1;
			// First read fails; the retry (attempt 2) succeeds with one run.
			return attempts === 1
				? Effect.fail({
						_tag: "WsRequestError",
						reason: "connection_lost",
					} as WsError)
				: Effect.succeed({
						runs: [item({ run_id: "r1", title: "Recovered run" })],
					});
		});

		expect(
			await screen.findByText(/couldn't load run history/i),
		).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /try again/i }));

		expect(await screen.findByText("Recovered run")).toBeInTheDocument();
		await waitFor(() =>
			expect(
				screen.queryByText(/couldn't load run history/i),
			).not.toBeInTheDocument(),
		);
	});
});
