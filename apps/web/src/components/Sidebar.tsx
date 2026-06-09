import { Copy, Library, Plus } from "lucide-react";
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
					className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg bg-secondary px-3 text-left font-semibold text-secondary-foreground text-sm transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_12%,var(--secondary))]"
				>
					<Plus className="size-4 shrink-0" aria-hidden />
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

			<ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
				{filtered.length === 0 ? (
					<li className="px-3 py-2 text-muted-foreground text-xs">
						No threads match.
					</li>
				) : (
					filtered.map((item) => {
						const isCurrent = item.id === focusedThreadId;
						return (
							<li
								key={item.id}
								className={cn(
									"group relative flex h-10 items-center rounded-lg pr-1 transition-colors",
									isCurrent ? "bg-secondary/70" : "hover:bg-primary/10",
								)}
							>
								{isCurrent && (
									<span
										aria-hidden="true"
										className="pointer-events-none absolute top-1/2 left-2 size-[5px] -translate-y-1/2 rounded-full bg-primary"
									/>
								)}
								<button
									type="button"
									onClick={() => setFocusedThread(item.id)}
									aria-current={isCurrent ? "true" : undefined}
									className={cn(
										"h-full min-w-0 flex-1 cursor-pointer truncate rounded-lg py-0 pr-3 pl-[18px] text-left text-sm",
										isCurrent
											? "font-semibold text-secondary-foreground"
											: "text-sidebar-foreground",
									)}
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
									className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/80 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
								>
									<Copy className="size-3.5" />
								</button>
							</li>
						);
					})
				)}
			</ul>
		</NavShell>
	);
}
