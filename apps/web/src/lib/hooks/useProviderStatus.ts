import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { useRuntime } from "@/runtime";

/** The live `provider/status` read via TanStack Query (reads path per ADR-0020),
 * shared under the `["provider-status"]` key. Exposes a provider-neutral
 * `anyConnected` derived from the rows so the chat surface can gate on "is any
 * provider connected" without naming a specific provider. */
export function useProviderStatus() {
	const runtime = useRuntime();
	const query = useQuery({
		queryKey: ["provider-status"],
		// Override the global QueryClient's `staleTime: Infinity` so this read is
		// never served from a permanently-stale cache: returning from /settings
		// remounts the chat column, which must re-read to lift the connect gate.
		staleTime: 0,
		refetchOnMount: "always",
		queryFn: () =>
			runtime.runPromise(
				Effect.flatMap(WsClient, (client) => client.providerStatus()),
			),
	});
	const anyConnected = query.data?.providers.some((p) => p.connected) ?? false;
	return { ...query, anyConnected };
}
