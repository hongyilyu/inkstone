import type {
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Cause, Effect, Exit } from "effect";
import { useRuntime } from "@/runtime";

/**
 * A user-initiated `entity/mutate` (ADR-0033) that refreshes the Library on success.
 *
 * Generic over `{mutation_kind, payload}` so the rail's Todo/Person/Project/Journal
 * forms all reuse it. A `WsError` rejects the mutation (React Query's `error`); callers
 * render it. `onSuccess` invalidates `["library-items"]` so the changed Entity shows up.
 *
 * We run via `runPromiseExit` and reject with the SQUASHED cause rather than letting
 * `runPromise` wrap the failure in Effect's `FiberFailure`. A `FiberFailure` is an
 * `Error` whose `.message` falls back to the generic "An error has occurred" when its
 * head error (here a `WsRequestError`, whose own `.message` is "") carries no text —
 * so callers reading `error.message` would surface that internal string instead of the
 * real `WsError`. Squashing hands callers the original `WsError` the docstring promises.
 */
export function useEntityMutation() {
	const runtime = useRuntime();
	const queryClient = useQueryClient();
	return useMutation<EntityMutateResult, unknown, EntityMutateParams>({
		mutationFn: async (params) => {
			const exit = await runtime.runPromiseExit(
				Effect.gen(function* () {
					const client = yield* WsClient;
					return yield* client.entityMutate(params);
				}),
			);
			if (Exit.isSuccess(exit)) return exit.value;
			throw Cause.squash(exit.cause);
		},
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["library-items"] }),
	});
}
