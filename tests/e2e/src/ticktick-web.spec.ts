import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	createServer as createNetServer,
	type Server as NetServer,
} from "node:net";
import { expect, test as harness } from "./fixtures.js";
import { type SpawnedCore, spawnCore } from "./spawnCore.js";

/**
 * The hidden Web lane, full stack (external-task-views A2/S2): Core reads
 * TickTick's OpenAPI through the real `TickTickClient` against a fake server
 * serving small hand-authored wire responses, and the dev-flagged `/library/tasks`
 * route renders the normalized rows via the reconnect-protocol hook. Proves the
 * whole wiring end-to-end — status-first → the connection-ID key → the two reads
 * → normalization (NOTE discarded, 200→199) → the truncation warning — that the
 * unit + integration tests exercise in pieces.
 *
 * The account-swap-across-restart variant (a Core restart swapping the token →
 * a new connection ID → the tab's old-ID task data cleared) is proven
 * end-to-end in the second section below; its deterministic unit lives in
 * apps/web/test/lib/hooks/useTickTick.test.tsx.
 */

function taskResponse(): string {
	const tasks = [
		{
			id: "timed",
			projectId: "list-1",
			title: "Timed task",
			kind: "TEXT",
			priority: 0,
			tags: ["advanced"],
			dueDate: "2026-08-20T17:30:00.000+0000",
			isAllDay: false,
			timeZone: "America/Los_Angeles",
		},
		...Array.from({ length: 198 }, (_, index) => ({
			id: `task-${index}`,
			projectId: "list-1",
			title: `Task ${index}`,
			kind: "TEXT",
			priority: 0,
			tags: [],
		})),
		{
			id: "note-1",
			projectId: "list-1",
			title: "Hidden note",
			kind: "NOTE",
		},
	];
	return JSON.stringify(tasks);
}

/** The port a just-listening TCP server bound.
 * SAFETY: these servers listen on a TCP port, so `address()` is an `AddressInfo`
 * (it is a string only for a UNIX pipe) and non-null inside `listen`. */
const boundPort = (server: Server | NetServer): number =>
	(server.address() as AddressInfo).port;

/** A fake TickTick OpenAPI server with one project and a 200-row task page. */
function startFakeOpenApi(): Promise<{
	url: string;
	close: () => Promise<void>;
}> {
	const projects = JSON.stringify([{ id: "list-1", name: "Work" }]);
	const tasks = taskResponse();
	const server: Server = createServer((req, res) => {
		// The task filter is a POST with a body; drain it before replying.
		req.on("data", () => {});
		req.on("end", () => {
			const body = req.url?.startsWith("/open/v1/project") ? projects : tasks;
			res.writeHead(200, { "content-type": "application/json" }).end(body);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = boundPort(server);
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () =>
					new Promise((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}

// The fake OpenAPI server lives INSIDE the `core` fixture: it is its only
// consumer, and a fixture of its own would need Playwright's empty-destructure
// idiom to declare "no dependencies".
const test = harness.extend({
	core: async ({ coreOptions }, use) => {
		const fake = await startFakeOpenApi();
		// Spread coreOptions so a `test.use({ coreOptions })` here is honored, not
		// silently dropped (review M11) — matching external-tools.spec's fixture.
		const core = await spawnCore({
			...coreOptions,
			ticktickApiUrl: fake.url,
		});
		await use(core);
		await core.shutdown();
		await fake.close();
	},
});

test("renders the normalized tasks and the truncation warning at /library/tasks", async ({
	chat,
}) => {
	// The route is dev-flagged (not in nav), reachable only by URL.
	await chat.gotoPath("/library/tasks");

	// The rows rendered — the fake's 200-row page normalizes to 199 visible
	// (the one NOTE discarded).
	const rows = chat.page.getByTestId("ticktick-task");
	await expect(rows.first()).toBeVisible({ timeout: 15_000 });
	await expect(rows).toHaveCount(199);

	// The 200-row page tripped the truncation ceiling → the warning renders.
	await expect(
		chat.page.getByTestId("ticktick-truncation-warning"),
	).toContainText("200-item limit");

	// The representative task is present with its list resolved from /project.
	await expect(chat.page.getByText("Timed task")).toBeVisible();
});

// ── Account swap across a Core restart (external-task-views A2, review #2) ────

/** A free TCP port (bind :0, read it, release) — Core then binds it for real. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createNetServer();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = boundPort(srv);
			srv.close(() => resolve(port));
		});
	});
}

/** A fake OpenAPI server that serves a DIFFERENT single task per account,
 * keyed by the `Authorization` bearer token — so a token swap changes the
 * account's tasks. `/project` is empty (the task carries an inbox sentinel so
 * it renders under "Inbox"). */
function startPerTokenServer(tasksByToken: Record<string, string>): Promise<{
	url: string;
	close: () => Promise<void>;
}> {
	const server: Server = createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			const auth = String(req.headers.authorization ?? "").replace(
				/^Bearer /,
				"",
			);
			if (req.url?.startsWith("/open/v1/project")) {
				res.writeHead(200, { "content-type": "application/json" }).end("[]");
				return;
			}
			const title = tasksByToken[auth] ?? "unknown-account";
			const task = {
				id: `task-${auth}`,
				projectId: "inbox1234",
				title,
				kind: "TEXT",
				priority: 0,
				tags: [],
				status: 0,
			};
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify([task]));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = boundPort(server);
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () =>
					new Promise((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}

// This test manages its own Core lifecycle (two spawns on a fixed port), so it
// opts OUT of the per-test `core` fixture via the base harness.
harness(
	"swapping the account across a Core restart clears account A's tasks (A2 reconnect)",
	async ({ page }) => {
		const api = await startPerTokenServer({
			"token-A": "Account A task",
			"token-B": "Account B task",
		});
		let core: SpawnedCore | undefined;
		let port = 0;
		try {
			// Boot #1: account A. `freePort` releases the port before Core binds it,
			// so another process can steal it — retry with a FRESH port (bounded);
			// only the first boot may change ports (the restart must keep the same
			// origin for the tab's WebSocket reconnect).
			for (let attempt = 0; ; attempt++) {
				port = await freePort();
				try {
					core = await spawnCore({
						port,
						ticktickApiUrl: api.url,
						ticktickToken: "token-A",
					});
					break;
				} catch (error) {
					if (attempt >= 2) throw error;
				}
			}
			await page.goto(`${core.url}/library/tasks`);
			await expect(page.getByText("Account A task")).toBeVisible({
				timeout: 20_000,
			});

			// Restart Core on the SAME port + Workspace, swapped to account B —
			// a new boot mints a new connection_id (A5). The tab survives with A's
			// cached query data. Preserve the Workspace so the respawn genuinely
			// reuses the same DB/boot-state (a plain shutdown deletes the dir and
			// the "restart" would silently be a fresh boot — CodeRabbit #336); the
			// second Core's own shutdown in `finally` cleans it up.
			const workspaceDir = core.workspaceDir;
			await core.shutdown({ preserveWorkspace: true });
			// The restart retries the SAME port (a origin change would break the
			// tab's reconnect); the just-released port can need a beat to rebind.
			for (let attempt = 0; ; attempt++) {
				try {
					core = await spawnCore({
						port,
						reuseWorkspaceDir: workspaceDir,
						ticktickApiUrl: api.url,
						ticktickToken: "token-B",
					});
					break;
				} catch (error) {
					if (attempt >= 2) throw error;
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			}

			// The tab's WebSocket reconnects → status-first re-resolves the new
			// connection_id → the old-ID task data is cleared and B's task fetched.
			await expect(page.getByText("Account B task")).toBeVisible({
				timeout: 30_000,
			});
			// A's task never renders against B's connection (no account mixing).
			await expect(page.getByText("Account A task")).toHaveCount(0);
		} finally {
			await core?.shutdown();
			await api.close();
		}
	},
);
