import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { useRuntime } from "@/runtime";

/**
 * The live thread list — a `thread/list` read on the runtime via TanStack Query
 * (the reads path per ADR-0020). Shared by the Sidebar's thread list, the chat
 * header's title anchor, and the command palette so they read one cache entry
 * under `["threads"]`. `data` is undefined while loading or on error; callers
 * render empty, not throw. Pass `enabled: false` to defer the fetch (the
 * palette only needs threads while it's open).
 */
export function useThreads(options?: { enabled?: boolean }) {
	const runtime = useRuntime();
	return useQuery({
		queryKey: ["threads"],
		enabled: options?.enabled,
		queryFn: () =>
			runtime.runPromise(
				Effect.gen(function* () {
					const client = yield* WsClient;
					return yield* client.threadList();
				}),
			),
	});
}
