import { WorkerInbound, type RunEvent } from "@inkstone/protocol";
import { Effect, Schema as S, Stream, pipe } from "effect";

type Event = S.Schema.Type<typeof RunEvent>;

/**
 * Pure-Effect runtime: takes a Stream of input lines and an emitter for events.
 * Reads exactly the first line, decodes WorkerInbound, emits text_delta + done.
 */
export const run = <E = never>(
	stdin: Stream.Stream<string, E>,
	emit: (event: Event) => Effect.Effect<void>,
): Effect.Effect<void, E> =>
	Effect.gen(function* () {
		const first = yield* pipe(stdin, Stream.runHead);
		if (first._tag === "None") return;
		const inbound = S.decodeUnknownSync(WorkerInbound)(JSON.parse(first.value));
		yield* emit({ kind: "text_delta", delta: `echo: ${inbound.prompt}` });
		yield* emit({ kind: "done" });
	});
