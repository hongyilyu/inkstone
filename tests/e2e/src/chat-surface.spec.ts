import { expect, test } from "./fixtures.js";

/**
 * The harmonized chat surface (chat ↔ Library cohesion work). Asserts the
 * first-run welcome that teaches the Library loop and the shared nav chrome
 * both surfaces wear — all through the DOM a user touches (ADR-0019), against a
 * real Core serving the real SPA.
 */

test("opens with the first-run welcome", async ({ chat, page }) => {
	await chat.goto();

	// A fresh Workspace has no threads → the welcome teaches the chat→Library
	// loop (mirrors the Library's own empty state).
	await expect(
		page.getByRole("heading", { name: /start a chat/i }),
	).toBeVisible();
});

test("replaces the welcome with the transcript after the first send", async ({
	chat,
	page,
}) => {
	await chat.goto();
	await expect(
		page.getByRole("heading", { name: /start a chat/i }),
	).toBeVisible();

	await chat.send("hello");

	// The echo reply streams into a real transcript and the welcome is gone.
	await chat.waitForAssistantText("echo: hello");
	await expect(
		page.getByRole("heading", { name: /start a chat/i }),
	).toHaveCount(0);
});

test("chat and Library wear the same shared nav chrome", async ({
	chat,
	page,
}) => {
	await chat.goto();

	// The chat sidebar footer carries the relocated theme toggle.
	await expect(
		chat.sidebar().getByRole("button", { name: /toggle theme/i }),
	).toBeVisible();

	// Cross into the Library takeover via the sidebar's Library entry.
	await chat
		.sidebar()
		.getByRole("button", { name: /^library$/i })
		.click();

	// The Library nav renders the identical shell: brand wordmark + footer toggle.
	const libNav = page.getByRole("navigation", { name: /library/i });
	await expect(libNav).toBeVisible();
	// `exact` targets the wordmark, not the connection indicator's sr-only
	// "Connected to Inkstone" status text that also lives in this nav (ADR-0051).
	await expect(libNav.getByText("Inkstone", { exact: true })).toBeVisible();
	await expect(
		libNav.getByRole("button", { name: /toggle theme/i }),
	).toBeVisible();
});
