import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * The reasoning segment survives reload (ADR-0045 amendment, #202). A turn whose
 * faux provider emits a thinking block THEN the reply renders the model's thinking
 * as a fourth segment kind: a default-collapsed disclosure positioned ABOVE the
 * reply (it happened first), with the trace text hidden until expanded and never
 * leaking into the reply prose. After a cold reload the disclosure is still
 * present, still collapsed, still correctly ordered — the rehydration path
 * (`thread/get`'s `segments[]` + the Core-computed duration) must match the live
 * order, exactly like its sibling `segment-timeline-reload.spec.ts` proves for the
 * decided-proposal pill.
 *
 * Driven by the faux interpreter Worker's `INKSTONE_FAUX_THINKING` mode: one turn
 * emitting `[thinking, text]`. The turn settles fast so the duration is sub-second
 * and the label is a bare "Thought".
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxThinking: "Let me weigh the options carefully.",
	},
});

/** Within the assistant turn, is the reasoning disclosure positioned ABOVE the
 * reply text? `DOCUMENT_POSITION_FOLLOWING` (4) ⇒ the reply follows the reasoning
 * row in DOM order (reasoning first = correct chronological order, since the faux
 * emits thinking THEN text). */
async function reasoningAboveReply(
	page: import("@playwright/test").Page,
): Promise<"reasoning-above" | "reasoning-below" | "missing"> {
	return page.evaluate(() => {
		const bubble = document.querySelector('[data-role="assistant"]');
		const reasoning = Array.from(bubble?.querySelectorAll("button") ?? []).find(
			(el) => /thought|thinking/i.test(el.textContent ?? ""),
		);
		const reply = Array.from(bubble?.querySelectorAll(".prose") ?? []).find(
			(el) => /here is the answer/i.test(el.textContent ?? ""),
		);
		if (!reasoning || !reply) return "missing";
		return reasoning.compareDocumentPosition(reply) & 4
			? "reasoning-above"
			: "reasoning-below";
	});
}

test("a thinking block renders as a collapsed reasoning row, ordered above the reply, surviving reload", async ({
	chat,
}) => {
	await chat.goto();
	await chat.send("think about it");

	// The reply settles after the thinking block.
	await chat.waitForAssistantText(/here is the answer/i);

	// The reasoning trace renders as a collapsed disclosure: a button whose name
	// matches /thought|thinking/i (the fast faux turn settles to "Thought").
	const disclosure = chat.page.getByRole("button", {
		name: /thought|thinking/i,
	});
	await expect(disclosure).toBeVisible();
	// Collapsed by default — the body (and thus the trace text) is hidden.
	await expect(disclosure).toHaveAttribute("aria-expanded", "false");
	await expect(
		chat.page.getByText("Let me weigh the options carefully."),
	).toBeHidden();

	// ORDER: the reasoning row sits ABOVE the reply (it happened first).
	expect(await reasoningAboveReply(chat.page)).toBe("reasoning-above");

	// NO-LEAK: the reply prose excludes the reasoning trace end-to-end.
	const reply = chat.page.locator(".prose", { hasText: /here is the answer/i });
	await expect(reply).not.toContainText("Let me weigh the options carefully.");

	const threadUrl = chat.pathname();
	expect(threadUrl).toMatch(/^\/thread\//);

	// Cold reload: the store reinitializes empty, so the rendered order + the
	// reasoning segment come entirely from `thread/get`'s `segments[]`.
	await chat.reload();
	expect(chat.pathname()).toBe(threadUrl);
	await chat.waitForAssistantText(/here is the answer/i);

	// RELOAD: the disclosure SURVIVES, still collapsed, still ABOVE the reply.
	const reloadedDisclosure = chat.page.getByRole("button", {
		name: /thought|thinking/i,
	});
	await expect(reloadedDisclosure).toBeVisible();
	await expect(reloadedDisclosure).toHaveAttribute("aria-expanded", "false");
	await expect(
		chat.page.getByText("Let me weigh the options carefully."),
	).toBeHidden();
	expect(await reasoningAboveReply(chat.page)).toBe("reasoning-above");
	const reloadedReply = chat.page.locator(".prose", {
		hasText: /here is the answer/i,
	});
	await expect(reloadedReply).not.toContainText(
		"Let me weigh the options carefully.",
	);

	// Expand → the trace becomes visible (the disclosure works after reload).
	await reloadedDisclosure.click();
	await expect(
		chat.page.getByText("Let me weigh the options carefully."),
	).toBeVisible();
});
