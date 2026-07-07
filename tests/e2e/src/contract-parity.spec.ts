// Runtime contract parity (the behavioral leg of the schema-parity gate).
//
// The `tests/contract` gate proves the two schema DEFINITIONS agree — Rust
// `PayloadSpec::json_schema()` ≡ the hand-authored Effect Schema — entirely
// offline, against committed fixtures. It can't prove the locked schema accepts
// what Core actually EMITS at runtime. This spec closes that gap end-to-end:
// it drives a real agent-proposed mutation through the browser SPA, observes the
// pending ProposalCard render in headless Chromium, reads the live `payload` over
// the very `proposal/get` wire the SPA itself calls, and decodes it against the
// `@inkstone/protocol` Effect Schema for its `mutation_kind`. A clean decode
// proves Core's runtime payload satisfies the schema the structural gate locks.
//
// The negative control (corrupt the live payload → decode must fail) proves the
// assertion bites rather than passing vacuously.

import path from "node:path";
import { schemas, type WireKind } from "@inkstone/protocol";
import { Either, Schema } from "effect";
import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD, PROPOSE_WORKER_CMD, REPO_ROOT } from "./spawnCore.js";

/** Minimal JSON-RPC response frame: `{ id, result }` or `{ id, error }`
 * (mirrors the ui-sdk wire — packages/ui-sdk/src/index.ts:64-65). */
interface RpcResponse {
	id: number;
	result?: { mutation_kind: string; payload: unknown };
	error?: { code: number; message: string };
}

/** Read a pending proposal's live payload over the SPA's own `proposal/get`
 * wire: open a WebSocket to Core's `/ws`, issue the request, resolve on the
 * matching id. This is exactly what `apps/web` calls (ui-sdk proposalGet →
 * request("proposal/get", { run_id }, ProposalGetResult)). */
function proposalGet(
	coreUrl: string,
	runId: string,
): Promise<{ mutation_kind: string; payload: unknown }> {
	const wsUrl = `${coreUrl.replace(/^http/, "ws")}/ws`;
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		const id = 1;
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error(`proposal/get timed out for run ${runId}`));
		}, 10_000);
		ws.addEventListener("open", () => {
			ws.send(
				JSON.stringify({
					jsonrpc: "2.0",
					id,
					method: "proposal/get",
					params: { run_id: runId },
				}),
			);
		});
		ws.addEventListener("message", (event) => {
			const frame = JSON.parse(String(event.data)) as RpcResponse;
			if (frame.id !== id) return; // ignore notifications / other ids
			clearTimeout(timer);
			ws.close();
			if (frame.error) {
				reject(new Error(`proposal/get failed: ${frame.error.message}`));
			} else if (frame.result) {
				resolve(frame.result);
			} else {
				reject(new Error("proposal/get response had neither result nor error"));
			}
		});
		ws.addEventListener("error", () => {
			clearTimeout(timer);
			ws.close();
			reject(new Error(`WebSocket error connecting to ${wsUrl}`));
		});
	});
}

test.describe("faux proposal parity", () => {
	// The faux interpreter Worker emits a deterministic `create_journal_entry`
	// proposal (packages/worker/src/faux/faux-worker.ts) — no LLM, no flake.
	test.use({
		coreOptions: {
			workerCmd: FAUX_WORKER_CMD,
			faux: "propose",
			proposeParamsFile: path.join(
				REPO_ROOT,
				"tests/e2e/fixtures/faux-propose-journal.json",
			),
		},
	});

	test("the live proposal payload Core emits decodes against its @inkstone/protocol schema", async ({
		chat,
		core,
	}) => {
		await chat.goto();
		await chat.send("I bought milk after daycare pickup and felt relieved.");

		// The proposal renders in the browser — the user-observable behavior.
		const card = chat.proposalCard();
		await expect(card).toBeVisible({ timeout: 15_000 });
		const runId = await card.getAttribute("data-proposal");
		expect(runId, "the ProposalCard carries its run_id").toBeTruthy();

		// Read the live payload over the SPA's own wire.
		const { mutation_kind, payload } = await proposalGet(
			core.url,
			runId as string,
		);
		expect(mutation_kind, "faux propose emits a create_journal_entry").toBe(
			"create_journal_entry",
		);
		expect(
			mutation_kind in schemas,
			`${mutation_kind} is a known proposable kind`,
		).toBe(true);

		// The contract assertion: Core's runtime payload satisfies the locked schema.
		// `schemas[kind]` is the heterogeneous registry's union type; widen to a
		// single no-requirements existential (`Schema<unknown, unknown>`, Context =
		// never) so `decodeUnknownEither` takes one schema rather than the conflicting
		// union of all proposable kinds.
		const schema = schemas[mutation_kind as WireKind] as Schema.Schema<
			unknown,
			unknown
		>;
		const decodeStrict = Schema.decodeUnknownEither(schema, {
			onExcessProperty: "error",
		});
		const decoded = decodeStrict(payload);
		if (Either.isLeft(decoded)) {
			throw new Error(
				`live ${mutation_kind} payload did NOT match its @inkstone/protocol schema:\n` +
					`${JSON.stringify(payload, null, 2)}\n` +
					`decode error: ${String(decoded.left)}`,
			);
		}
		expect(Either.isRight(decoded)).toBe(true);

		// Negative control — the decode genuinely bites: drop a required field
		// (`body` is required on create_journal_entry) and confirm it now fails.
		const corrupted = { ...(payload as Record<string, unknown>) };
		delete corrupted.body;
		expect(
			Either.isLeft(decodeStrict(corrupted)),
			"removing the required `body` field must fail the decode",
		).toBe(true);
		expect(
			Either.isLeft(
				decodeStrict({
					...(payload as Record<string, unknown>),
					unexpected_field: true,
				}),
			),
			"adding an unknown top-level field must fail the strict decode",
		).toBe(true);
	});
});

test.describe("record_observations proposal parity", () => {
	test.use({
		coreOptions: {
			workerCmd: PROPOSE_WORKER_CMD,
			proposalParamsFile: path.join(
				REPO_ROOT,
				"tests/e2e/fixtures/record-observations-proposal.json",
			),
		},
	});

	test("a live record_observations proposal payload decodes against its @inkstone/protocol schema", async ({
		chat,
		core,
	}) => {
		await chat.goto();
		await chat.send("record bodyweight and habit check-in");
		const card = chat.proposalCard();
		await expect(card).toBeVisible({ timeout: 15_000 });
		const runId = await card.getAttribute("data-proposal");
		expect(runId, "the ProposalCard carries its run_id").toBeTruthy();

		const { mutation_kind, payload } = await proposalGet(
			core.url,
			runId as string,
		);
		expect(mutation_kind).toBe("record_observations");
		const schema = schemas[mutation_kind as WireKind] as Schema.Schema<
			unknown,
			unknown
		>;
		const decodeStrict = Schema.decodeUnknownEither(schema, {
			onExcessProperty: "error",
		});
		const decoded = decodeStrict(payload);
		if (Either.isLeft(decoded)) {
			throw new Error(
				`live ${mutation_kind} payload did NOT match its @inkstone/protocol schema:\n` +
					`${JSON.stringify(payload, null, 2)}\n` +
					`decode error: ${String(decoded.left)}`,
			);
		}
		expect(Either.isRight(decoded)).toBe(true);

		const corrupted = { ...(payload as Record<string, unknown>) };
		delete corrupted.observations;
		expect(
			Either.isLeft(decodeStrict(corrupted)),
			"removing the required `observations` field must fail the decode",
		).toBe(true);
		expect(
			Either.isLeft(
				decodeStrict({
					...(payload as Record<string, unknown>),
					unexpected_field: true,
				}),
			),
			"adding an unknown top-level field must fail the strict decode",
		).toBe(true);
	});
});
