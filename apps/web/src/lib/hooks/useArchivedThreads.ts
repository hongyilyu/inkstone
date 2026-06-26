import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { useRuntime } from "@/runtime";

/** The `thread/list_archived` read via TanStack Query (ADR-0052), cached under the
 * `["threads","archived"]` key — the inverse of {@link useThreads}'s active list.
 * Mirrors `useThreads` exactly (same runtime/Effect shape). */
export function useArchivedThreads(options?: { enabled?: boolean }) {
	const runtime = useRuntime();
	return useQuery({
		queryKey: ["threads", "archived"],
		enabled: options?.enabled,
		queryFn: () =>
			runtime.runPromise(
				Effect.gen(function* () {
					const client = yield* WsClient;
					return yield* client.threadListArchived();
				}),
			),
	});
}
