import { FAUX_WORKER_CMD } from "./spawnCore.js";
import { expect, test } from "./fixtures.js";

/**
 * Light + dark screenshot gallery (chat-markdown-rendering slice 4, ADR-0021).
 * The faux provider streams a RICH markdown completion through the real
 * interpreter, and for each theme (light, dark) we drive the app, assert the
 * assistant bubble rendered structural markdown (a real <h1>, <table>, and
 * <code>), and capture the bubble into RUN_DIR/screenshots as a human-review
 * artifact. The PNGs are NOT a pixel-diff baseline — their existence is not an
 * assertion; the structural DOM checks are the hard gate.
 *
 * Theme seam (DECOMPOSE.md "Theme seam", ADR-0021 §Theming): the FOUC script in
 * apps/web/index.html reads localStorage["inkstone-theme"] on load and sets
 * document.documentElement.dataset.theme. Theme is a page concern (not a Core
 * concern), so we keep ONE faux coreOptions block for the whole file and seed
 * the theme per-test via addInitScript BEFORE goto().
 */
const RICH_MARKDOWN_REPLY = `# Markdown Gallery

This reply exercises **bold** and *italic* text, plus inline \`code\`.

- first item
- second item
- third item

| Col A | Col B |
| ----- | ----- |
| a1    | b1    |
| a2    | b2    |

See the [Inkstone docs](https://inkstone.test/docs) for more.

> A blockquote for good measure.

\`\`\`ts
const greet = (name: string) => \`hello \${name}\`;
\`\`\`
`;

const SCREENSHOT_DIR =
	"/Users/lyuhongy/dev/inkstone/.agents/runs/chat-markdown-rendering/screenshots";

test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxResponse: RICH_MARKDOWN_REPLY,
	},
});

for (const theme of ["light", "dark"] as const) {
	test(`rich markdown reply renders and screenshots in ${theme} theme`, async ({
		chat,
		page,
	}) => {
		// Seed the theme BEFORE the page loads so the FOUC script applies it.
		await page.addInitScript((t) => {
			localStorage.setItem("inkstone-theme", t);
		}, theme);

		await chat.goto();

		// Confirm the FOUC script actually applied the seeded theme.
		await expect
			.poll(() => page.evaluate(() => document.documentElement.dataset.theme))
			.toBe(theme);

		await chat.send("render markdown");
		await chat.waitForAssistantText("Markdown Gallery");

		const bubble = chat.assistantBubbles().first();

		// Structural assertions — the hard pass/fail gate.
		const heading = bubble.locator("h1");
		await expect(heading).toHaveCount(1);
		await expect(heading).toBeVisible();

		await expect(bubble.locator("table")).toHaveCount(1);
		await expect(bubble.locator("table")).toBeVisible();

		await expect(bubble.locator("code").first()).toBeVisible();

		// Human-review artifact: snapshot the rendered bubble for this theme.
		// Existence is NOT an assertion — the structural checks above are.
		await bubble.screenshot({
			path: `${SCREENSHOT_DIR}/markdown-${theme}.png`,
		});
	});
}
