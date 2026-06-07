import { WsClient, WsRequestError } from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { resetBridge, sendNewThread } from "./bridge.js";
import { getChatState, resetChatStore } from "./chat.js";

// A stub WsClient whose `threadCreate` FAILS, exercised through the slice-10
// RuntimeProvider injection seam: a runtime built from
// `ManagedRuntime.make(Layer.succeed(WsClient, stub))` (no real socket). Only
// `threadCreate` runs on the `sendNewThread` path; the rest are never reached.
function makeFailingThreadCreateRuntime() {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => Effect.fail(new WsRequestError({ reason: "boom" })),
		postMessage: () => unused,
		threadList: () => unused,
		threadGet: () => unused,
		listTodos: () => unused,
		subscribeRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		proposalDecide: () => unused,
		proposalNotifications: () => unused,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

beforeEach(() => {
	resetChatStore();
	resetBridge();
});

describe("sendNewThread failure handling", () => {
	it("surfaces a failed threadCreate as { ok: false } instead of swallowing it", async () => {
		const runtime = makeFailingThreadCreateRuntime();

		const result = await sendNewThread(runtime, "hi");

		expect(result).toEqual({ ok: false, error: expect.anything() });
		// No thread was minted and nothing got focused — nothing to clean up.
		expect(Object.keys(getChatState().threads)).toHaveLength(0);
		expect(getChatState().focusedThreadId).toBeUndefined();

		await runtime.dispose();
	});
});
