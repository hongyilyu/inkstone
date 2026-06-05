import { useQuery } from "@tanstack/react-query";
import { entities } from "@/data/mock/entities";

/**
 * Accepted Entities for the Library (VISUAL ONLY — no entity store in Core yet).
 *
 * Wrapped in a query (no `placeholderData`) so the loading + cache behaviour is
 * the real path the future live wiring will use: the first Library visit paints
 * a skeleton for a frame, subsequent visits read the cache (staleTime is
 * Infinity app-wide). Mock data resolves synchronously, so loading is brief.
 */
export function useEntities() {
	return useQuery({
		queryKey: ["entities"],
		queryFn: async () => entities,
	});
}
