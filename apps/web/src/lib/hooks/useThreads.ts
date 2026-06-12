import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { useRuntime } from "@/runtime";

/** The live `thread/list` read via TanStack Query (reads path per ADR-0020), shared under the `["threads"]` cache key; pass `enabled: false` to defer the fetch. */
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
