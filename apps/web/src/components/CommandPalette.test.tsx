import { WsClient, type WsError } from "@inkstone/ui-sdk";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, Stream } from "effect";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeTree } from "@/routeTree.gen";
import { RuntimeProvider } from "@/runtime";
import { openCommand, resetCommandStore } from "@/store/command";
import { renderWithQuery } from "@/test-utils/renderWithQuery";

const die = (): Effect.Effect<never, never> => Effect.die("unused");
const dieStream = (): Stream.Stream<never, WsError> =>
	Stream.fromEffect(Effect.die("unused")) as Stream.Stream<never, WsError>;

// Stub: empty threadList so the open-triggered query resolves; Alice (person)
// and a matching daycare todo seeded as stable live entity/list results.
const stub = WsClient.of({
	threadCreate: die,
	postMessage: die,
	threadList: () => Effect.succeed({ threads: [] }),
	getRunHistory: () => Effect.die("not exercised"),
	recurrencePreview: () => Effect.die("not exercised in this test"),
	threadGet: die,
	threadRename: die,
	threadArchive: die,
	threadUnarchive: die,
	threadListArchived: die,
	listEntities: (type) => {
		if (type === "person") {
			return Effect.succeed({
				entities: [
					{
						id: "person_alice",
						type: "person",
						data: { name: "Alice Whitman" },
						created_at: 1_700_000_000_000,
						updated_at: 1_700_000_000_000,
					},
				],
			});
		}
		if (type === "todo") {
			return Effect.succeed({
				entities: [
					{
						id: "todo_schedule_alice",
						type: "todo",
						data: {
							title: "Send Alice the updated daycare schedule",
							status: "active",
						},
						created_at: 1_700_000_000_000,
						updated_at: 1_700_000_000_000,
					},
				],
			});
		}
		if (type === "media") {
			return Effect.succeed({
				entities: [
					{
						id: "media_dune",
						type: "media",
						data: { title: "Dune", medium: "book", state: "backlog" },
						created_at: 1_700_000_000_000,
						updated_at: 1_700_000_000_000,
					},
				],
			});
		}
		return Effect.succeed({ entities: [] });
	},
	getBacklinks: die,
	observationQuery: die,
	observationUpdate: die,
	entityMutate: die,
	messageSearch: (query) =>
		query.trim().toLowerCase().includes("daycare")
			? Effect.succeed({
					hits: [
						{
							message_id: "msg_1",
							thread_id: "thread_x",
							run_id: "run_1",
							role: "user" as const,
							snippet: "…sort out the daycare schedule…",
							thread_title: "Daycare planning",
							created_at: 1_700_000_000_000,
						},
					],
				})
			: Effect.succeed({ hits: [] }),
	subscribeRun: dieStream,
	cancelRun: die,
	retryRun: die,
	providerStatus: die,
	providerLoginStart: die,
	providerConfigure: die,
	providerTest: die,
	modelCatalog: die,
	settingsGet: die,
	settingsSet: die,
	proposalGet: die,
	rescanJournalEntry: die,
	proposalDecide: die,
	proposalNotifications: () => Stream.empty,
	connectionStatus: () => Stream.empty,
});

function renderApp() {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: ["/library"] }),
	});
	renderWithQuery(
		<RuntimeProvider layer={Layer.succeed(WsClient, stub)}>
			<RouterProvider router={router} />
		</RuntimeProvider>,
	);
	return router;
}

// userEvent holds Meta while pressing k so the keydown listener sees metaKey (jsdom drops it on hand-built events).
const pressCmdK = () => userEvent.keyboard("{Meta>}k{/Meta}");
const openPalette = () => act(() => openCommand());
const PLACEHOLDER = /search threads, people, projects/i;

beforeEach(() => resetCommandStore());
afterEach(cleanup);

describe("CommandPalette (⌘K)", () => {
	it("is closed until the shortcut, then opens and filters", async () => {
		renderApp();
		expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();

		await pressCmdK();

		const input = await screen.findByPlaceholderText(PLACEHOLDER);
		await userEvent.type(input, "alice");

		// Scope to the palette listbox: these labels also appear on the page behind the dialog.
		const results = screen.getByRole("listbox", { name: /results/i });
		expect(
			await within(results).findByText("Alice Whitman"),
		).toBeInTheDocument();
		expect(within(results).getByText("People")).toBeInTheDocument();
	});

	it("activates the selected result with the keyboard and navigates", async () => {
		const router = renderApp();
		openPalette();
		const input = await screen.findByPlaceholderText(PLACEHOLDER);

		await userEvent.type(input, "alice whitman{Enter}");

		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/library/people");
			expect(router.state.location.search).toEqual({ id: "person_alice" });
		});
	});

	// Media's KIND_META slug ("media") collides with the STATIC /library/media topic
	// route, unlike every other kind which rides /library/$kind. Activating a Media
	// hit must still land on /library/media with `?id` intact (the static route reads
	// it; route.tsx mounts the detail rail) — a regression guard for the one slug that
	// shadows $kind (ADR-0059 web-surface routing).
	it("navigates to a Media item on the static topic route, preserving the id", async () => {
		const router = renderApp();
		openPalette();
		const input = await screen.findByPlaceholderText(PLACEHOLDER);

		await userEvent.type(input, "dune{Enter}");

		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/library/media");
			expect(router.state.location.search).toEqual({ id: "media_dune" });
		});
	});

	it("surfaces matching messages and navigates to their thread", async () => {
		const router = renderApp();
		openPalette();
		const input = await screen.findByPlaceholderText(PLACEHOLDER);

		await userEvent.type(input, "daycare");

		const results = screen.getByRole("listbox", { name: /results/i });
		// A "Messages" group renders the hit's snippet + thread title.
		expect(await within(results).findByText("Messages")).toBeInTheDocument();
		const snippet = "…sort out the daycare schedule…";
		expect(within(results).getByText(snippet)).toBeInTheDocument();
		expect(within(results).getByText("Daycare planning")).toBeInTheDocument();

		// Messages is purely additive: the client-side Library search still matches
		// the seeded "daycare" todo, so its group renders alongside Messages.
		expect(
			within(results).getByText("Send Alice the updated daycare schedule"),
		).toBeInTheDocument();

		// Activating a message hit navigates to that Thread's route (ADR-0061) and
		// deep-links the within-thread scroll anchor in the search param — the ONE
		// thing that distinguishes a message hit from a plain thread hit (the thread
		// branch carries no search). Assert both so dropping the anchor regresses.
		await userEvent.click(within(results).getByText(snippet));

		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/thread/thread_x");
		});
		expect(router.state.location.search).toEqual({ focusedMessageId: "msg_1" });
	});

	it("shows no Messages group for an empty query", async () => {
		renderApp();
		openPalette();
		await screen.findByPlaceholderText(PLACEHOLDER);

		const results = screen.getByRole("listbox", { name: /results/i });
		expect(within(results).queryByText("Messages")).not.toBeInTheDocument();
	});

	it("teaches a no-match instead of going blank", async () => {
		renderApp();
		openPalette();
		const input = await screen.findByPlaceholderText(PLACEHOLDER);

		await userEvent.type(input, "zzznotanything");
		expect(await screen.findByText(/no matches for/i)).toBeInTheDocument();
	});

	it("re-clamps the active row when results shrink so Enter never no-ops", async () => {
		// "alice" matches BOTH the person (Alice Whitman) and the todo (…Alice…).
		// Arrow-key down to the last row, then narrow the query so the result set
		// shrinks out from under the cursor; the active index must re-clamp so Enter
		// still activates a real row (the bug: a stale index past the end → Enter
		// silently no-ops on `flat[active] === undefined`).
		const router = renderApp();
		openPalette();
		const input = await screen.findByPlaceholderText(PLACEHOLDER);

		await userEvent.type(input, "alice");
		const results = screen.getByRole("listbox", { name: /results/i });
		// Both the person (Alice Whitman) and the todo (…Alice…) match "alice".
		await waitFor(() =>
			expect(within(results).getByText("Alice Whitman")).toBeInTheDocument(),
		);
		expect(
			within(results).getByText("Send Alice the updated daycare schedule"),
		).toBeInTheDocument();

		// Move the selection toward the bottom of the multi-row result set.
		await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");

		// Narrow to a token only the todo matches ("daycare" is not in the person's
		// name), shrinking the list — the active index would now point past the end.
		await userEvent.type(
			input,
			"{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}daycare",
		);
		await waitFor(() =>
			expect(
				within(results).queryByText("Alice Whitman"),
			).not.toBeInTheDocument(),
		);
		// Only the todo remains.
		expect(
			within(results).getByText("Send Alice the updated daycare schedule"),
		).toBeInTheDocument();

		// Enter activates the clamped row (the surviving todo) and navigates — not a no-op.
		await userEvent.keyboard("{Enter}");
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/library/todos"),
		);
	});

	it("closes on Escape", async () => {
		renderApp();
		openPalette();
		const input = await screen.findByPlaceholderText(PLACEHOLDER);

		await userEvent.type(input, "{Escape}");
		await waitFor(() =>
			expect(
				screen.queryByPlaceholderText(PLACEHOLDER),
			).not.toBeInTheDocument(),
		);
	});
});
