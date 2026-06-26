import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArchiveRestore } from "lucide-react";
import { useArchivedThreads } from "@/lib/hooks/useArchivedThreads";
import { useThreadMutations } from "@/lib/hooks/useThreadMutations";
import { cn } from "@/lib/utils.js";

/**
 * `/archived` — the Archived-Threads view (ADR-0052). A `_chat` child route, so it
 * renders in the shell's `<Outlet/>` with the Sidebar + recent-Runs rail still
 * mounted. Lists archived Threads (`thread/list_archived`) with a per-row Restore
 * (`thread/unarchive`). On restore, the hook's `unarchive` already invalidates the
 * active `["threads"]` list (slice 4); a per-call `onSuccess` here also invalidates
 * `["threads","archived"]` so the restored row leaves this list. A simple utility
 * list — NOT the Library shell.
 */
function ArchivedView() {
	const queryClient = useQueryClient();
	const { data, isPending, isError } = useArchivedThreads();
	const { unarchive } = useThreadMutations();

	const threads = data?.threads ?? [];

	return (
		<div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto px-6 py-8">
			<header className="flex flex-col gap-1">
				<h1 className="font-semibold text-foreground text-lg">Archived</h1>
				<p className="text-muted-foreground text-sm">
					Archived conversations stay out of the sidebar but keep their messages
					and history. Restore one to bring it back.
				</p>
			</header>

			{isError && threads.length === 0 ? (
				// A failed read with NO cached rows must not read as a genuinely empty
				// archive — show an honest load-failure (mirrors Sidebar.tsx).
				<p className="text-muted-foreground text-sm">
					Couldn't load your archived conversations. Check that Inkstone is
					running.
				</p>
			) : isPending ? (
				<p className="text-muted-foreground text-sm">Loading…</p>
			) : threads.length === 0 ? (
				<p className="text-muted-foreground text-sm">No archived threads.</p>
			) : (
				<ul className="flex flex-col gap-1">
					{threads.map((item) => (
						<li
							key={item.id}
							className="flex h-10 items-center gap-2 rounded-lg pr-1 pl-3 transition-colors hover:bg-primary/10"
						>
							<span
								className="min-w-0 flex-1 truncate text-foreground text-sm"
								title={item.title}
							>
								{item.title}
							</span>
							<button
								type="button"
								aria-label={`Restore thread ${item.title}`}
								title="Restore"
								onClick={() =>
									unarchive.mutate(item.id, {
										onSuccess: () =>
											queryClient.invalidateQueries({
												queryKey: ["threads", "archived"],
											}),
									})
								}
								className={cn(
									"flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sidebar-foreground/80 text-sm transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
								)}
							>
								<ArchiveRestore className="size-4" aria-hidden />
								Restore
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

export const Route = createFileRoute("/_chat/archived")({
	component: ArchivedView,
});
