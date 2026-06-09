import { Copy, Library } from "lucide-react";
import { useState } from "react";
import { NavShell, navRow } from "@/components/ui/nav-shell";
import { useThreads } from "@/lib/hooks/useThreads";
import {
	clearFocusedThread,
	setFocusedThread,
	useFocusedThreadId,
} from "@/store/chat";
import { cn } from "../lib/utils.js";
import { SearchField } from "./ui/search-field.js";

export function Sidebar({
	onOpenLibrary,
}: {
	onOpenLibrary?: () => void;
} = {}) {
	const focusedThreadId = useFocusedThreadId();
	const [query, setQuery] = useState("");

	// Reads run on the runtime via TanStack Query (loading/error/success free);
	// the live stream stays on the store+bridge (ADR-0020). `data` is undefined
	// while loading or on error → render an empty list, never throw.
	const { data } = useThreads();

	const threads = data?.threads ?? [];
	const filtered = threads.filter((t) =>
		t.title.toLowerCase().includes(query.trim().toLowerCase()),
	);

	const newChat = () => {
		clearFocusedThread();
		setQuery("");
	};

	return (
		<NavShell as="aside" ariaLabel="Sidebar">
			<div className="flex flex-col gap-0.5">
				<button
					type="button"
					onClick={newChat}
					className="flex h-9 cursor-pointer items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground text-sm shadow-sm transition-colors hover:bg-primary/90"
				>
					New Chat
				</button>
				<button
					type="button"
					onClick={onOpenLibrary}
					className={cn(navRow, "w-full")}
				>
					<Library className="size-4 shrink-0" aria-hidden />
					Library
				</button>
			</div>

			<div className="mx-3 my-3 border-border border-t" />

			<SearchField
				variant="divider"
				tone="sidebar"
				aria-label="Search your threads"
				placeholder="Search your threads…"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
			/>

			<div className="px-3 pt-3 pb-1 font-semibold text-muted-foreground text-xs">
				Last 30 days
			</div>

			<ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
				{filtered.length === 0 ? (
					<li className="px-3 py-2 text-muted-foreground text-xs">
						No threads match.
					</li>
				) : (
					filtered.map((item) => (
						<li
							key={item.id}
							className={cn(
								"group flex h-9 items-center rounded-lg pr-1 transition-colors hover:bg-sidebar-accent",
								item.id === focusedThreadId && "bg-sidebar-accent",
							)}
						>
							<button
								type="button"
								onClick={() => setFocusedThread(item.id)}
								aria-current={item.id === focusedThreadId ? "true" : undefined}
								className="h-full min-w-0 flex-1 cursor-pointer truncate rounded-lg px-3 text-left text-sidebar-foreground text-sm"
							>
								{item.title}
							</button>
							<button
								type="button"
								aria-label={`Copy thread id for ${item.title}`}
								title="Copy thread id"
								onClick={() => {
									void navigator.clipboard?.writeText(item.id);
								}}
								className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/80 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 group-hover:opacity-100"
							>
								<Copy className="size-3.5" />
							</button>
						</li>
					))
				)}
			</ul>
		</NavShell>
	);
}
