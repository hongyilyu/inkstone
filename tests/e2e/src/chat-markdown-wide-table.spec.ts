import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

const WIDE_TABLE =
	"| A | B | C | D | E | F | G | H | I | J | K | L | M | N |\n" +
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n" +
	"| abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw | abcdefghijklmnopqrstuvw |";

test.describe(() => {
	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			fauxResponse: WIDE_TABLE,
		},
	});

	test("a wide GFM table scrolls in its own wrapper, not the whole column", async ({
		chat,
		page,
	}) => {
		await chat.goto();
		await chat.send("wide table please");
		await expect(page.locator("table")).toBeVisible();

		const wrapper = page.locator("table").locator("..");
		const wrapperScrollWidth = await wrapper.evaluate((el) => el.scrollWidth);
		const wrapperClientWidth = await wrapper.evaluate((el) => el.clientWidth);

		// The wrapper must constrain the table — scrollWidth > clientWidth means
		// overflow-x-auto is engaged on the wrapper div, not the transcript.
		expect(wrapperScrollWidth).toBeGreaterThan(wrapperClientWidth);

		// The transcript scroller must NOT overflow horizontally.
		const transcript = page.locator("main > div").first();
		const tScrollW = await transcript.evaluate((el) => el.scrollWidth);
		const tClientW = await transcript.evaluate((el) => el.clientWidth);
		expect(tScrollW).toBeLessThanOrEqual(tClientW + 5);
	});
});
