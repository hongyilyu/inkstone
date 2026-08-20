// The ticktick-writes demo proofs (W4 cutover): capture returns. "remind me to
// buy milk" parks a `create_ticktick_task` Proposal — never a Journal Entry —
// accept lands the task in the fake TickTick and the Tasks Topic shows it after
// the invalidated read; reject creates nothing and the model continues
// conversationally; a rejected TickTick POST reports the failure honestly.
//
// A fake TickTick OpenAPI server stands in for the service (the same seam
// `ticktick-web.spec.ts` uses): the create POST is recorded, and the filter
// read serves whatever has been created so far — so the Tasks view really
// reflects the accepted write.

import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect as baseExpect } from "@playwright/test";
import { test as harness } from "./fixtures.js";
import { FAUX_WORKER_CMD, type SpawnedCore, spawnCore } from "./spawnCore.js";

const expect = baseExpect;

/** The create body Core's typed client sends (`ticktick::client::CreateTaskBody`
 * — camelCase, optionals omitted). The spec asserts on these fields, and the
 * absence of `projectId` is the Inbox-only proof. */
interface CreateTaskBody {
	readonly title?: string;
	readonly content?: string;
	readonly dueDate?: string;
	readonly isAllDay?: boolean;
	readonly timeZone?: string;
	/** Never sent by the v1 payload — asserted absent. */
	readonly projectId?: string;
}

/** A created task row as TickTick returns it (and as the filter read serves
 * it): the fields `wire.rs` decodes. */
interface FakeTaskRow {
	readonly id: string;
	readonly projectId: string;
	readonly title: string;
	readonly kind: "TEXT";
	readonly status: 0;
	readonly dueDate?: string;
	readonly isAllDay?: boolean;
	readonly timeZone?: string;
	readonly content?: string;
}

interface FakeTickTick {
	url: string;
	/** Every `POST /open/v1/task` body the client sent, in order. */
	creates: CreateTaskBody[];
	/** Reply to the next create with this HTTP status (200 = created). */
	setCreateStatus: (status: number) => void;
	close: () => Promise<void>;
}

/** Parse a create request body into the named contract. The producer is Core's
 * OWN typed serializer (`CreateTaskBody`), so the cast names that contract
 * rather than widening anything; a malformed body degrades to an empty object
 * (the spec's assertions then fail loudly on the missing fields). */
function parseCreateBody(raw: string): CreateTaskBody {
	try {
		const decoded = JSON.parse(raw === "" ? "{}" : raw) as CreateTaskBody;
		return typeof decoded === "object" && decoded !== null ? decoded : {};
	} catch {
		return {};
	}
}

/** The row under construction in {@link createdRow} — the same fields as
 * {@link FakeTaskRow}, writable while the optional due/note are attached. */
type MutableTaskRow = { -readonly [K in keyof FakeTaskRow]: FakeTaskRow[K] };

/** The created row the fake returns (and later serves from the filter read):
 * the due tuple and note ride only when the create carried them. */
function createdRow(id: string, body: CreateTaskBody): FakeTaskRow {
	const row: MutableTaskRow = {
		id,
		// The Inbox sentinel: `wire.rs` maps an `inbox`-prefixed projectId to the
		// synthetic "Inbox" list name.
		projectId: "inbox1234567890",
		title: body.title ?? "",
		kind: "TEXT",
		status: 0,
	};
	if (body.dueDate !== undefined) {
		row.dueDate = body.dueDate;
		row.isAllDay = body.isAllDay ?? false;
		row.timeZone = body.timeZone ?? "";
	}
	if (body.content !== undefined) {
		row.content = body.content;
	}
	return row;
}

/** A fake TickTick OpenAPI: `POST /open/v1/task` creates (and records) a task;
 * `POST /open/v1/task/filter` serves the created tasks; `GET /open/v1/project`
 * serves an empty project list (created tasks land in the Inbox sentinel). */
function startFakeTickTick(): Promise<FakeTickTick> {
	const creates: CreateTaskBody[] = [];
	const rows: FakeTaskRow[] = [];
	let createStatus = 200;
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const url = req.url ?? "";
			/** Reply with a JSON body: a created/echoed task row, the task page,
			 * the (empty) project list, or a small error envelope. */
			const json = (
				status: number,
				body: FakeTaskRow | FakeTaskRow[] | { errorCode: string },
			) =>
				res
					.writeHead(status, { "content-type": "application/json" })
					.end(JSON.stringify(body));
			// Method-exact, so a regression away from the TickTick contract
			// (create + filter are POST, the project list is GET) fails here
			// rather than passing on a wrong verb.
			const method = req.method ?? "";
			if (url.startsWith("/open/v1/project")) {
				if (method !== "GET") {
					json(405, { errorCode: "method_not_allowed" });
					return;
				}
				json(200, []);
				return;
			}
			if (url.startsWith("/open/v1/task/filter")) {
				if (method !== "POST") {
					json(405, { errorCode: "method_not_allowed" });
					return;
				}
				json(200, rows);
				return;
			}
			if (url.startsWith("/open/v1/task")) {
				if (method !== "POST") {
					json(405, { errorCode: "method_not_allowed" });
					return;
				}
				if (createStatus !== 200) {
					// A deterministic rejection: nothing is created.
					json(createStatus, { errorCode: "rejected" });
					return;
				}
				const body = parseCreateBody(Buffer.concat(chunks).toString("utf8"));
				creates.push(body);
				const created = createdRow(`tt-${creates.length + 0}`, body);
				rows.push(created);
				json(200, created);
				return;
			}
			json(404, { errorCode: "not_found" });
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({
				url: `http://127.0.0.1:${port}`,
				creates,
				setCreateStatus: (status: number) => {
					createStatus = status;
				},
				close: () =>
					new Promise((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}

/** One `ticktick_task` scenario turn the faux propose mode plays back. */
interface TickTickTurn {
	readonly action: "ticktick_task";
	readonly title: string;
	readonly note?: string;
	readonly due?: {
		readonly date: string;
		readonly is_all_day?: boolean;
		readonly time_zone?: string;
	};
}

/** Write a one-turn faux scenario proposing a TickTick task. */
function writeScenario(turn: TickTickTurn): string {
	const dir = mkdtempSync(path.join(tmpdir(), "inkstone-ticktick-write-"));
	const file = path.join(dir, "scenario.json");
	writeFileSync(file, JSON.stringify({ turns: [turn] }), "utf8");
	return file;
}

// The fake TickTick is started by the `core` fixture — Core reads the API URL
// at boot, so the server must exist first — and keyed to that Core instance so
// the `ticktick` fixture can hand the running one to the test. (A standalone
// fixture would need Playwright's empty-destructure idiom, which the lint
// rules reject; depending on `core` states the real ordering anyway.)
const fakeByCore = new WeakMap<SpawnedCore, FakeTickTick>();

const test = harness.extend<{ ticktick: FakeTickTick }>({
	core: async ({ coreOptions }, use) => {
		const fake = await startFakeTickTick();
		const core = await spawnCore({
			...coreOptions,
			workerCmd: FAUX_WORKER_CMD,
			faux: "propose",
			ticktickApiUrl: fake.url,
		});
		fakeByCore.set(core, fake);
		await use(core);
		await core.shutdown();
		await fake.close();
	},
	ticktick: async ({ core }, use) => {
		const fake = fakeByCore.get(core);
		if (fake === undefined) {
			throw new Error("the core fixture did not start a fake TickTick");
		}
		await use(fake);
	},
});

test.describe("the headline: capture returns", () => {
	test.use({
		coreOptions: {
			proposeParamsFile: writeScenario({
				action: "ticktick_task",
				title: "buy milk",
			}),
		},
	});

	test("a reminder parks a TickTick task proposal; accept lands it in TickTick and the Tasks view", async ({
		chat,
		ticktick,
	}) => {
		await chat.goto();
		await chat.send("remind me to buy milk");

		// A reminder parks a TickTick task card — never a Journal Entry.
		const card = chat.page.locator('[data-proposal-status="pending"]').last();
		await expect(card).toBeVisible({ timeout: 20_000 });
		await expect(card).toContainText(
			"Inkstone wants to create a task in TickTick.",
		);
		await expect(card).toContainText("buy milk");
		await expect(card).toContainText("→ Inbox");
		await expect(chat.page.getByText(/add journal entry/i)).toHaveCount(0);
		const runId = await card.getAttribute("data-proposal");

		// Accept → exactly one POST → the created row.
		await card.getByRole("button", { name: /create in ticktick/i }).click();
		const decided = chat.page.locator(`[data-proposal="${runId}"]`);
		await expect(decided).toContainText(/created in ticktick/i, {
			timeout: 20_000,
		});
		expect(ticktick.creates).toHaveLength(1);
		expect(ticktick.creates[0]).toMatchObject({ title: "buy milk" });
		// Inbox-only: the v1 payload never names a list, tags, or priority.
		expect(ticktick.creates[0]).not.toHaveProperty("projectId");

		// The model relays the outcome on resume.
		await chat.waitForAssistantText(/it's in TickTick/i);

		// The Tasks Topic shows it (the invalidated read refetches).
		await chat.gotoPath("/library/tasks");
		await expect(chat.page.getByText("buy milk")).toBeVisible({
			timeout: 20_000,
		});
		await expect(chat.page.getByText("Inbox").first()).toBeVisible();
	});
});

test.describe("reject", () => {
	test.use({
		coreOptions: {
			proposeParamsFile: writeScenario({
				action: "ticktick_task",
				title: "buy milk",
			}),
		},
	});

	test("dismissing the card creates nothing and the model continues", async ({
		chat,
		ticktick,
	}) => {
		await chat.goto();
		await chat.send("remind me to buy milk");

		const card = chat.page.locator('[data-proposal-status="pending"]').last();
		await expect(card).toBeVisible({ timeout: 20_000 });
		const runId = await card.getAttribute("data-proposal");
		await card.getByRole("button", { name: /dismiss/i }).click();

		await expect(chat.page.locator(`[data-proposal="${runId}"]`)).toContainText(
			/dismissed/i,
			{ timeout: 20_000 },
		);
		await chat.waitForAssistantText(/dismissed it/i);
		expect(ticktick.creates).toHaveLength(0);
	});
});

test.describe("edit", () => {
	test.use({
		coreOptions: {
			proposeParamsFile: writeScenario({
				action: "ticktick_task",
				title: "buy milk",
				note: "2%",
			}),
		},
	});

	test("the edited title is what reaches TickTick", async ({
		chat,
		ticktick,
	}) => {
		await chat.goto();
		await chat.send("remind me to buy milk");

		const card = chat.page.locator('[data-proposal-status="pending"]').last();
		await expect(card).toBeVisible({ timeout: 20_000 });
		const runId = await card.getAttribute("data-proposal");
		await card.getByRole("button", { name: /edit/i }).click();
		await card.getByRole("textbox", { name: /title/i }).fill("buy oat milk");
		await card.getByRole("button", { name: /save changes/i }).click();

		await expect(chat.page.locator(`[data-proposal="${runId}"]`)).toContainText(
			/created in ticktick/i,
			{ timeout: 20_000 },
		);
		expect(ticktick.creates).toHaveLength(1);
		// The EDITED payload is what phase B sent (replace semantics).
		expect(ticktick.creates[0]).toMatchObject({
			title: "buy oat milk",
			content: "2%",
		});
	});
});

test.describe("failure honesty", () => {
	test.use({
		coreOptions: {
			proposeParamsFile: writeScenario({
				action: "ticktick_task",
				title: "buy milk",
			}),
		},
	});

	test("a rejected write reports NOT created — never a success-shaped card", async ({
		chat,
		ticktick,
	}) => {
		ticktick.setCreateStatus(401);
		await chat.goto();
		await chat.send("remind me to buy milk");

		const card = chat.page.locator('[data-proposal-status="pending"]').last();
		await expect(card).toBeVisible({ timeout: 20_000 });
		const runId = await card.getAttribute("data-proposal");
		await card.getByRole("button", { name: /create in ticktick/i }).click();

		const decided = chat.page.locator(`[data-proposal="${runId}"]`);
		await expect(decided).toContainText(/not created/i, { timeout: 20_000 });
		await expect(decided).toContainText("HTTP 401");
		await expect(decided).not.toContainText(/created in ticktick \(/i);
		// The model relays the failure rather than claiming success.
		await chat.waitForAssistantText(/didn't take it|was not created/i);
	});
});
