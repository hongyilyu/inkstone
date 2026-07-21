import type { WsClient } from "@inkstone/ui-sdk";
import { Cause, type Effect, Exit } from "effect";
import type { WsRuntime } from "@/runtime";

/**
 * Run an SDK Effect on the runtime and, on failure, reject with the SQUASHED
 * cause instead of Effect's `FiberFailure` wrapper. A `FiberFailure`'s `.message`
 * falls back to the generic "An error has occurred" when its head error (a
 * `WsRequestError`, whose own `.message` is "") carries no text — so callers
 * reading `error.message` would surface that internal string. Squashing hands
 * callers the original `WsError`.
 */
export async function runSquashed<A, E>(
	runtime: WsRuntime,
	effect: Effect.Effect<A, E, WsClient>,
): Promise<A> {
	const exit = await runtime.runPromiseExit(effect);
	if (Exit.isSuccess(exit)) return exit.value;
	throw Cause.squash(exit.cause);
}
