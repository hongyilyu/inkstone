import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { routeTree } from "@/routeTree.gen";

// This file renders multiple routers across tests; the repo's vitest config
// does not set `globals: true`, so testing-library's auto-cleanup isn't wired.
// Clean up between tests so a prior render's DOM can't leak into the next.
afterEach(cleanup);

function makeRouter(initialPath: string) {
	return createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [initialPath] }),
	});
}

async function renderAt(initialPath: string) {
	const router = makeRouter(initialPath);
	await renderWithCore(<RouterProvider router={router} />, {
		wsConfig: { url: "ws://stub/ws" },
	});
}

describe("settings/models route (ADR-0024)", () => {
	it("renders the Models settings page with the settings shell", async () => {
		await renderAt("/settings/models");

		expect(
			await screen.findByRole("heading", { name: /^models$/i }),
		).toBeInTheDocument();
		// The shell chrome: a "Back to Chat" affordance.
		expect(
			screen.getByRole("link", { name: /back to chat/i }),
		).toBeInTheDocument();
	});

	it("navigates from the chat settings gear to /settings/models", async () => {
		const user = userEvent.setup();
		await renderAt("/");

		// The chat surface is mounted at "/".
		await screen.findByRole("main");
		// No settings heading yet.
		expect(
			screen.queryByRole("heading", { name: /^models$/i }),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /^settings$/i }));

		expect(
			await screen.findByRole("heading", { name: /^models$/i }),
		).toBeInTheDocument();
	});
});
