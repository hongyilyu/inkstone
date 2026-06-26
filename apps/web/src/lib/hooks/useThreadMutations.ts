import type { ThreadMutateResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Cause, Effect, Exit } from "effect";
import { useRuntime } from "@/runtime";

/**
 * The Thread-lifecycle mutations (ADR-0052): `rename`, `archive`, `unarchive`,
 * each a `useMutation` over the slice-3 `WsClient` verbs. Mirrors
 * {@link useEntityMutation} — run via `runtime.runPromiseExit` and reject with the
 * SQUASHED cause (so callers reading `error.message` get the real `WsError`, not
 * Effect's `FiberFailure` "An error has occurred" fallback) — and on success
 * invalidates the `["threads"]` read so the sidebar list re-reads (the renamed row
 * shows its new title; the archived row drops out, since slice-1 `thread/list`
 * filters `archived_at IS NULL`).
 *
 * Deliberately navigation-free: archiving the *focused* Thread must also reselect
 * the route, but that decision needs `useParams` + the navigation handler, which
 * live in the Sidebar — the caller owns it (per-call `onSuccess`).
 */
export function useThreadMutations() {
	const runtime = useRuntime();
	const queryClient = useQueryClient();

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: ["threads"] });

	const rename = useMutation<
		ThreadMutateResult,
		unknown,
		{ threadId: string; title: string }
	>({
		mutationFn: async ({ threadId, title }) => {
			const exit = await runtime.runPromiseExit(
				Effect.gen(function* () {
					const client = yield* WsClient;
					return yield* client.threadRename(threadId, title);
				}),
			);
			if (Exit.isSuccess(exit)) return exit.value;
			throw Cause.squash(exit.cause);
		},
		onSuccess: invalidate,
	});

	const archive = useMutation<ThreadMutateResult, unknown, string>({
		mutationFn: async (threadId) => {
			const exit = await runtime.runPromiseExit(
				Effect.gen(function* () {
					const client = yield* WsClient;
					return yield* client.threadArchive(threadId);
				}),
			);
			if (Exit.isSuccess(exit)) return exit.value;
			throw Cause.squash(exit.cause);
		},
		onSuccess: invalidate,
	});

	const unarchive = useMutation<ThreadMutateResult, unknown, string>({
		mutationFn: async (threadId) => {
			const exit = await runtime.runPromiseExit(
				Effect.gen(function* () {
					const client = yield* WsClient;
					return yield* client.threadUnarchive(threadId);
				}),
			);
			if (Exit.isSuccess(exit)) return exit.value;
			throw Cause.squash(exit.cause);
		},
		onSuccess: invalidate,
	});

	return { rename, archive, unarchive };
}
