import { expect, test } from "./fixtures.js";

/**
 * Chat image attachments end-to-end (ADR-0058): attach a PNG via the composer's
 * hidden file input, send, and the user bubble renders it inline from
 * `GET /media/{id}` — immediately (optimistic seed) and after a cold reload
 * (thread/get rehydration). The default gate Worker ignores attachments; this
 * spec proves the UI + upload + serving path, not model vision.
 */

/** 1x1 transparent PNG — small, valid, and enough to round-trip the pipeline. */
const PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

test("attach an image, send, see it render, reload and it survives", async ({
	chat,
	core,
	page,
}) => {
	await chat.goto();

	// Attach via the hidden file input behind the Attach chip.
	await page.locator('input[type="file"]').setInputFiles({
		name: "pixel.png",
		mimeType: "image/png",
		buffer: PIXEL_PNG,
	});

	// The pending thumbnail appears in the composer strip (alt = file name).
	await expect(page.getByRole("img", { name: "pixel.png" })).toBeVisible();

	await chat.send("look at this image");

	// The sent user bubble renders the attachment inline from /media/{id}.
	const userImg = chat.userBubbles().locator('img[src^="/media/"]');
	await expect(userImg).toBeVisible({ timeout: 15_000 });
	// The pending thumbnail strip cleared with the send.
	await expect(page.getByRole("img", { name: "pixel.png" })).toHaveCount(0);

	// The media route serves the bytes back with the uploaded Content-Type.
	const imgSrc = await userImg.getAttribute("src");
	const response = await page.request.get(`${core.url}${imgSrc}`);
	expect(response.status()).toBe(200);
	expect(response.headers()["content-type"]).toBe("image/png");
	expect((await response.body()).equals(PIXEL_PNG)).toBe(true);

	// Wait for the turn to settle so reload rehydrates from persisted state.
	await chat.waitForAssistantText("echo: look at this image");

	// Cold reload: the store reinitializes empty, so the rendered image comes
	// entirely from thread/get's attachment segment.
	await chat.reload();
	await expect(chat.userBubbles().locator('img[src^="/media/"]')).toBeVisible({
		timeout: 15_000,
	});
});
