import {
	type ConnectionStatus,
	type RunEventValue,
	WsClient,
	type WsError,
} from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBridge, startConnectionStream } from "./bridge.js";
import {
	getConnectionStatus,
	resetConnectionStore,
	setConnectionStatus,
} from "./connection.js";

/**
 * A WsClient stub whose `connectionStatus()` is driven by a caller-owned
 * `SubscriptionRef` — matching production semantics (slice-1 holds the live
 * status in a SubscriptionRef and exposes `.changes`). The other ~20 methods
 * use the `Effect.die` idiom; `subscribeRun`/`proposalNotifications` return
 * STREAMS, not Effects.
 */
function makeRuntime(sub: SubscriptionRef.SubscriptionRef<ConnectionStatus>) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory: () => unused,
		threadGet: () => unused,
		listEntities: () => unused,
		getBacklinks: () => unused,
		entityMutate: () => unused,
		subscribeRun: (): Stream.Stream<RunEventValue, WsError> => Stream.empty,
		cancelRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		rescanJournalEntry: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => Stream.empty,
		connectionStatus: () => sub.changes,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

let runtime: ManagedRuntime.ManagedRuntime<WsClient, never> | undefined;

beforeEach(() => {
	resetBridge();
	resetConnectionStore();
});

afterEach(async () => {
	await runtime?.dispose();
	runtime = undefined;
});

describe("startConnectionStream (ADR-0051 — fork connectionStatus into the store)", () => {
	/** Push `status` into the SubscriptionRef and flush the fork's propagation. */
	async function drive(
		rt: ManagedRuntime.ManagedRuntime<WsClient, never>,
		sub: SubscriptionRef.SubscriptionRef<ConnectionStatus>,
		status: ConnectionStatus,
	): Promise<void> {
		await rt.runPromise(SubscriptionRef.set(sub, status));
		// Yield so the forked runForEach fiber observes the change and writes the store.
		await new Promise((r) => setTimeout(r, 0));
	}

	it("drives the store through reconnecting → disconnected → connected as the stream emits", async () => {
		const sub = await Effect.runPromise(
			SubscriptionRef.make<ConnectionStatus>("connected"),
		);
		runtime = makeRuntime(sub);

		startConnectionStream(runtime);
		// The SubscriptionRef replays its current value on subscribe (slice-1):
		// the fork re-asserts "connected" immediately.
		await new Promise((r) => setTimeout(r, 0));
		expect(getConnectionStatus()).toBe("connected");

		await drive(runtime, sub, "reconnecting");
		expect(getConnectionStatus()).toBe("reconnecting");

		await drive(runtime, sub, "disconnected");
		expect(getConnectionStatus()).toBe("disconnected");

		await drive(runtime, sub, "connected");
		expect(getConnectionStatus()).toBe("connected");
	});

	it("is idempotent: a second call forks no second fiber", async () => {
		const sub = await Effect.runPromise(
			SubscriptionRef.make<ConnectionStatus>("connected"),
		);
		runtime = makeRuntime(sub);

		// Count the forks directly: the guard's real job is that a second call must
		// NOT reach `runtime.runFork(program)` and spawn a duplicate live
		// subscription. A pure value assertion can't see this — two fibers both
		// last-write the same status, observationally identical to one — so spy on
		// the fork itself. Removing the `connectionFiber !== undefined` guard in
		// bridge.ts makes this call twice and turns the test RED.
		const forkSpy = vi.spyOn(runtime, "runFork");

		startConnectionStream(runtime);
		startConnectionStream(runtime);
		await new Promise((r) => setTimeout(r, 0));

		expect(forkSpy).toHaveBeenCalledTimes(1);
	});

	it("resetBridge drops the fork guard so a fresh fork can start", async () => {
		const sub = await Effect.runPromise(
			SubscriptionRef.make<ConnectionStatus>("connected"),
		);
		runtime = makeRuntime(sub);

		startConnectionStream(runtime);
		await new Promise((r) => setTimeout(r, 0));
		await runtime.dispose();
		resetBridge();

		// A new runtime + fork after reset must take effect (the guard was cleared).
		const sub2 = await Effect.runPromise(
			SubscriptionRef.make<ConnectionStatus>("reconnecting"),
		);
		runtime = makeRuntime(sub2);
		startConnectionStream(runtime);
		await new Promise((r) => setTimeout(r, 0));
		expect(getConnectionStatus()).toBe("reconnecting");
	});

	it("setConnectionStatus writes the store directly (the stream's sink)", () => {
		setConnectionStatus("disconnected");
		expect(getConnectionStatus()).toBe("disconnected");
	});
});
