import type { ThreadMutateResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { runSquashed } from "@/lib/runSquashed";
import { useRuntime } from "@/runtime";

/**
 * The Thread-lifecycle mutations (ADR-0052): `rename`, `archive`, `unarchive`,
 * each a `useMutation` over the slice-3 `WsClient` verbs. Mirrors
 * {@link useEntityMutation} — reject with the real `WsError` via {@link runSquashed}
 * — and on success
 * invalidates the `["threads"]` read so the sidebar list re-reads (the renamed row
 * shows its new title; the archived row drops out, since slice-1 `thread/list`
 * filters `archived_at IS NULL`).
 *
 * Deliberately navigation-free: archiving the *focused* Thread must also reselect
 * the route, but that decision needs `useParams` + the navigation handler, which
 * live in the Sidebar — the caller owns it (per-call `onSuccess`). Returning the
 * `invalidateQueries` promise here would make React Query AWAIT the `["threads"]`
 * refetch before running that per-call `onSuccess`, delaying the reselect off
 * `/thread/$id`; `void` keeps the invalidation fire-and-forget so reselect is
 * immediate. The `["threads"]` key prefix-matches `["threads","archived"]` (v5
 * invalidation is non-exact by default), so the archived list refreshes too — no
 * per-view invalidation is needed at the call sites.
 */
export function useThreadMutations() {
	const runtime = useRuntime();
	const queryClient = useQueryClient();

	const invalidate = () => {
		void queryClient.invalidateQueries({ queryKey: ["threads"] });
	};

	const rename = useMutation<
		ThreadMutateResult,
		unknown,
		{ threadId: string; title: string }
	>({
		mutationFn: ({ threadId, title }) =>
			runSquashed(
				runtime,
				Effect.flatMap(WsClient, (client) =>
					client.threadRename(threadId, title),
				),
			),
		onSuccess: invalidate,
	});

	const archive = useMutation<ThreadMutateResult, unknown, string>({
		mutationFn: (threadId) =>
			runSquashed(
				runtime,
				Effect.flatMap(WsClient, (client) => client.threadArchive(threadId)),
			),
		onSuccess: invalidate,
	});

	const unarchive = useMutation<ThreadMutateResult, unknown, string>({
		mutationFn: (threadId) =>
			runSquashed(
				runtime,
				Effect.flatMap(WsClient, (client) => client.threadUnarchive(threadId)),
			),
		onSuccess: invalidate,
	});

	return { rename, archive, unarchive };
}
