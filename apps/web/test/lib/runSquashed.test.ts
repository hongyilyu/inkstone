import { WsClient, WsRequestError } from "@inkstone/ui-sdk";
import { makeCoreRuntime } from "@test/test-utils/renderWithCore";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runSquashed } from "@/lib/runSquashed";

// The runtime is backed by a stub WsClient; `runSquashed` runs an Effect over it
// and either returns the success value or throws the SQUASHED cause (the real
// error), never Effect's `FiberFailure` wrapper.
describe("runSquashed", () => {
	it("returns the success value", async () => {
		const runtime = makeCoreRuntime({
			overrides: {
				entityMutate: () => Effect.succeed({ entity_id: "e1" }),
			},
		});

		const result = await runSquashed(
			runtime,
			Effect.flatMap(WsClient, (client) =>
				client.entityMutate({ mutation_kind: "create_person", payload: {} }),
			),
		);

		expect(result).toEqual({ entity_id: "e1" });
	});

	it("throws the squashed cause (the real WsError, not a FiberFailure)", async () => {
		const failure = new WsRequestError({ reason: "connection_lost" });
		const runtime = makeCoreRuntime({
			overrides: {
				entityMutate: () => Effect.fail(failure),
			},
		});

		await expect(
			runSquashed(
				runtime,
				Effect.flatMap(WsClient, (client) =>
					client.entityMutate({ mutation_kind: "create_person", payload: {} }),
				),
			),
		).rejects.toBe(failure);
	});
});
