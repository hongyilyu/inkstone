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

// Core may be offline; the palette degrades to entities-only. threadList just
// returns an empty set so the (enabled-on-open) query resolves cleanly.
const stub = WsClient.of({
	threadCreate: die,
	postMessage: die,
	threadList: () => Effect.succeed({ threads: [] }),
	threadGet: die,
	listEntities: () => Effect.succeed({ entities: [] }),
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

// Real ⌘K: userEvent faithfully holds Meta while pressing k, so the window
// keydown listener sees metaKey set (jsdom ignores the modifier on a hand-built
// KeyboardEvent init).
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

		// Scope to the palette's listbox: "Alice Whitman" and "People" also appear
		// on the page behind the dialog.
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
