import { INTERPRETER_WORKER_CMD } from "./spawnCore.js";
import { expect, test } from "./fixtures.js";

/**
 * Markdown-rendering acceptance flow (chat-markdown-rendering slice 1, ADR-0021).
 * The faux provider streams a markdown completion through the real interpreter
 * (INTERPRETER_WORKER_CMD), and we assert through the real Chromium DOM that the
 * assistant bubble rendered it as formatted HTML — a real <h1>, a real GFM
 * <table>, and a real <a target="_blank"> with rel containing noreferrer — not
 * a literal string. A screenshot of the bubble is captured as a human-review
 * artifact (its existence is NOT an assertion; the DOM checks are the gate).
 */
const MARKDOWN_REPLY = `# Markdown Heading

Here is a list:

- first item
- second item

| Col A | Col B |
| ----- | ----- |
| a1    | b1    |
| a2    | b2    |

See the [Inkstone docs](https://inkstone.test/docs) for more.

\`\`\`ts
const greet = (name: string) => \`hello \${name}\`;
\`\`\`
`;

const SCREENSHOT_PATH =
	"/Users/lyuhongy/dev/inkstone/.agents/runs/chat-markdown-rendering/screenshots/markdown-slice1.png";

test.use({
	coreOptions: {
		workerCmd: INTERPRETER_WORKER_CMD,
		fauxResponse: MARKDOWN_REPLY,
	},
});

test("assistant markdown reply renders as formatted HTML in chromium", async ({
	chat,
}) => {
	await chat.goto();

	await chat.send("show me markdown");

	// Wait for the assistant bubble to render the reply (the heading text lands
	// inside the rendered <h1>).
	await chat.waitForAssistantText("Markdown Heading");

	const bubble = chat.assistantBubbles().first();

	// Real <h1> from the `# ...` heading.
	const heading = bubble.locator("h1");
	await expect(heading).toHaveCount(1);
	await expect(heading).toHaveText("Markdown Heading");

	// Real GFM <table>.
	await expect(bubble.locator("table")).toHaveCount(1);
	await expect(bubble.locator("table")).toBeVisible();

	// Real <a target="_blank"> with rel containing noreferrer.
	const link = bubble.locator('a[target="_blank"]');
	await expect(link).toHaveCount(1);
	await expect(link).toBeVisible();
	await expect(link).toHaveAttribute("rel", /noreferrer/);

	// Human-review artifact: snapshot the rendered bubble. Existence is not an
	// assertion — the DOM checks above are the hard gate.
	await bubble.screenshot({ path: SCREENSHOT_PATH });
});
