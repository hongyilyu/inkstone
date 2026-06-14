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

// Stub: empty threadList so the open-triggered query resolves; Alice seeded as a stable live-People result.
const stub = WsClient.of({
	threadCreate: die,
	postMessage: die,
	threadList: () => Effect.succeed({ threads: [] }),
	threadGet: die,
	listEntities: (type) =>
		Effect.succeed({
			entities:
				type === "person"
					? [
							{
								id: "person_alice",
								type: "person",
								data: { name: "Alice Whitman" },
								created_at: 1_700_000_000_000,
								updated_at: 1_700_000_000_000,
							},
						]
					: [],
		}),
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
	providerStatus: die,
	providerLoginStart: die,
	modelCatalog: die,
	settingsGet: die,
	settingsSet: die,
	proposalGet: die,
	proposalDecide: die,
	proposalNotifications: () => Stream.empty,
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

		// Activating a message hit focuses its Thread and navigates home.
		await userEvent.click(within(results).getByText(snippet));

		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/");
		});
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
