import type { QueryClient } from "@tanstack/react-query";

/**
 * Invalidate the two entity read caches a write can stale, in one call: the flat
 * Library list (`["library-items"]`) and every open Inspector's per-entity backlink
 * read (`["entity-backlinks"]`, ADR-0050 — a prefix that matches each
 * `["entity-backlinks", id]` query). A write changes both what the Library shows and
 * what links to an open Entity (a new mention/todo link), so the two refresh
 * together. The single owner of that policy, so a new entity-writing path can't
 * refresh one and forget the other. Returns the combined promise for callers that
 * await the refetch before advancing.
 */
export function invalidateEntityReads(queryClient: QueryClient): Promise<void> {
	return Promise.all([
		queryClient.invalidateQueries({ queryKey: ["library-items"] }),
		queryClient.invalidateQueries({ queryKey: ["entity-backlinks"] }),
	]).then(() => undefined);
}
