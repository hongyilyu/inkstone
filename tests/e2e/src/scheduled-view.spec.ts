import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities } from "./seed.js";

/**
 * Full-system proof of the #232 Scheduled view (a throwaway stopgap, superseded
 * by the shared Forecast/calendar view in #236): seed an active Todo deferred to
 * a future date plus a plain active Todo, then drive the real `/library/scheduled`
 * route to assert only the deferred Todo lists there.
 *
 * The Inbox assertion is the load-bearing part: the deferred Todo must STILL
 * appear in Inbox. The #232 scope decision was that deferring a Todo does NOT
 * remove it from active views — Scheduled OVERLAPS Inbox rather than replacing it.
 */

const TODO_DEFERRED = "01900000-0000-7000-8000-0000000000d1";
const TODO_PLAIN = "01900000-0000-7000-8000-0000000000d2";

test("Scheduled lists future-deferred todos and they still appear in Inbox (overlap)", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedEntities(dbPath, [
		{
			id: TODO_DEFERRED,
			type: "todo",
			data: {
				title: "Renew passport",
				status: "active",
				defer_at: "2099-01-01T00:00:00",
			},
		},
		{
			id: TODO_PLAIN,
			type: "todo",
			data: { title: "Buy stamps", status: "active" },
		},
	]);

	// ── Scheduled: only the future-deferred todo ────────────────────────────
	await page.goto(`${core.url}/library/scheduled`);
	const scheduled = page.getByRole("region", { name: /scheduled/i });
	await expect(scheduled.getByText("Renew passport")).toBeVisible({
		timeout: 15_000,
	});
	// The non-deferred control must NOT appear in Scheduled.
	await expect(scheduled.getByText("Buy stamps")).toHaveCount(0);

	// ── Inbox overlap: the deferred todo is STILL in Inbox (no removal) ──────
	// This is the key behavioral guarantee of the #232 scope decision.
	await page.goto(`${core.url}/library/inbox`);
	const inbox = page.getByRole("region", { name: /inbox/i });
	await expect(inbox.getByText("Renew passport")).toBeVisible({
		timeout: 15_000,
	});
	await expect(inbox.getByText("Buy stamps")).toBeVisible();
});
