import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { run } from "./index.js";

describe("worker run", () => {
	it("echoes prompt as text_delta and done", async () => {
		const stdin = Stream.fromIterable(['{"prompt":"hi"}']);
		const emitted: Array<unknown> = [];
		const emit = (event: unknown): Effect.Effect<void> =>
			Effect.sync(() => {
				emitted.push(event);
			});
		await Effect.runPromise(
			run(stdin, emit as Parameters<typeof run>[1]),
		);
		expect(emitted).toEqual([
			{ kind: "text_delta", delta: "echo: hi" },
			{ kind: "done" },
		]);
	});
});
