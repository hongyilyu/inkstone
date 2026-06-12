import { FAUX_WORKER_CMD } from "./spawnCore.js";
import { expect, test } from "./fixtures.js";

/**
 * Markdown-rendering acceptance flow (chat-markdown-rendering slice 1, ADR-0021).
 * The faux provider streams a markdown completion through the real interpreter
 * (FAUX_WORKER_CMD), and we assert through the real Chromium DOM that the
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

const STREAMING_SCREENSHOT_PATH =
	"/Users/lyuhongy/dev/inkstone/.agents/runs/chat-markdown-rendering/screenshots/streaming-slice2.png";

const COPY_SCREENSHOT_PATH =
	"/Users/lyuhongy/dev/inkstone/.agents/runs/chat-markdown-rendering/screenshots/copy-slice3.png";

test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
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

/**
 * Streaming-render transition (chat-markdown-rendering slice 2). Proves the
 * streaming render path works end-to-end in a real browser: a gated 2-chunk
 * Run shows the FIRST chunk's partial text in the assistant bubble while held
 * mid-stream, then renders the FULL echo once the gate is tripped.
 *
 * Gate semantics (crates/core/tests/fixtures/slow-worker.ts): the fixture emits
 * the first chunk THEN pauses on the gate. With `chunks: 2` the prompt
 * "hi there" yields `echo: hi there` (14 chars) split as "echo: h" + "i there",
 * so the first chunk is "echo: h". Because the first delta has already arrived
 * by the time the run is gated, the assistant bubble already has text — the
 * `status === "streaming" && text === ""` window the typing-indicator gates on
 * is NOT observable here (see slices/2/OPEN-QUESTIONS.md). That empty-text
 * indicator behavior is proven authoritatively by the vitest test; this e2e leg
 * asserts the streaming-render transition it CAN observe and only asserts the
 * indicator's ABSENCE once text is present.
 */
test.describe("streaming render", () => {
	test.use({ coreOptions: { chunks: 2 } });

	test("gated mid-stream shows partial text, then full text after tripGate", async ({
		chat,
		core,
	}) => {
		await chat.goto();

		await chat.send("hi there");

		// While GATED (after chunk 1, before tripping): the assistant bubble has
		// appeared with the FIRST chunk's partial text ("echo: h"), but NOT the
		// full echo. Web-first auto-retrying assertions settle on the gated
		// state — the gate holds the stream open, so the bubble stays in its
		// first-chunk form until we trip it.
		await chat.waitForAssistantText("echo: h");
		await chat.expectNoAssistantText("echo: hi there");

		// No typing indicator here: text already arrived with chunk 1, so the
		// empty-text indicator window never opens (OPEN-QUESTIONS.md deviation).
		const bubble = chat.assistantBubbles().first();
		await expect(bubble).toBeVisible();
		await expect(bubble).toContainText("echo: h");

		// Human-review artifact: snapshot the mid-stream bubble.
		await bubble.screenshot({ path: STREAMING_SCREENSHOT_PATH });

		// Release the gate → the remaining chunk streams in → full echo renders.
		core.tripGate();
		await chat.waitForAssistantText("echo: hi there");

		// Once text is present the typing indicator is absent (its only assertion
		// here, per OPEN-QUESTIONS.md — never asserted visible mid-stream).
		await expect(
			chat.assistantBubbles().getByTestId("typing-indicator"),
		).toHaveCount(0);
	});
});

/**
 * Copy button on completed assistant messages (chat-markdown-rendering slice 3).
 * A short faux reply completes; the assistant bubble exposes a hover-revealed
 * copy button (accessible name /copy/i, see apps/web/src/components/CopyButton.tsx).
 * Clicking it writes the message text to the real browser clipboard, which we
 * read back through `chat.clipboardText()`. Clipboard permission is granted on
 * the browser context BEFORE navigating (mirrors tool-read-thread.spec.ts). The
 * button is opacity-0 until group-hover but stays in the DOM, so we hover the
 * bubble to reveal it before clicking.
 */
test.describe("copy button", () => {
	const COPY_REPLY = "copy me please";

	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			fauxResponse: COPY_REPLY,
		},
	});

	test("clicking copy on a completed reply writes its text to the clipboard", async ({
		chat,
		page,
	}) => {
		// Grant clipboard permission on the context BEFORE navigating.
		await page
			.context()
			.grantPermissions(["clipboard-read", "clipboard-write"]);

		await chat.goto();

		await chat.send("hi");
		await chat.waitForAssistantText(COPY_REPLY);

		const bubble = chat.assistantBubbles().first();

		// The copy button is hover-revealed (group-hover opacity) but in the DOM.
		// Hover the bubble to reveal it, then click.
		await bubble.hover();
		const copyButton = bubble.getByRole("button", { name: /copy/i });
		await copyButton.click();

		// The clipboard write is async — poll until it settles on the reply text.
		await expect.poll(() => chat.clipboardText()).toBe(COPY_REPLY);

		// Human-review artifact: snapshot the bubble in its copied state.
		await bubble.screenshot({ path: COPY_SCREENSHOT_PATH });
	});
});
