import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { PanelLeftClose, Search, UserPlus, WandSparkles } from "lucide-react";
import { useState } from "react";
import { useRuntime } from "@/runtime";
import {
	clearFocusedThread,
	setFocusedThread,
	useFocusedThreadId,
} from "@/store/chat";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";

export function Sidebar({
	onToggleCollapse,
}: {
	onToggleCollapse?: () => void;
} = {}) {
	const runtime = useRuntime();
	const focusedThreadId = useFocusedThreadId();
	const [query, setQuery] = useState("");

	// Reads run on the runtime via TanStack Query (loading/error/success free);
	// the live stream stays on the store+bridge (ADR-0020). `data` is undefined
	// while loading or on error → render an empty list, never throw.
	const { data } = useQuery({
		queryKey: ["threads"],
		queryFn: () =>
			runtime.runPromise(
				Effect.gen(function* () {
					const client = yield* WsClient;
					return yield* client.threadList();
				}),
			),
	});

	const threads = data?.threads ?? [];
	const filtered = threads.filter((t) =>
		t.title.toLowerCase().includes(query.trim().toLowerCase()),
	);

	const newChat = () => {
		clearFocusedThread();
		setQuery("");
	};

	return (
		<aside
			aria-label="Sidebar"
			className="flex h-full flex-col bg-sidebar text-sm text-sidebar-foreground"
		>
			<div className="grid h-14 grid-cols-3 items-center px-3">
				<Button
					variant="icon"
					size="icon"
					aria-label="Toggle sidebar"
					onClick={onToggleCollapse}
				>
					<PanelLeftClose className="size-4" />
				</Button>
				<div className="text-center text-base font-bold text-foreground">
					Inkstone
				</div>
				<Button
					variant="icon"
					size="icon"
					className="justify-self-end"
					aria-label="New thread"
					onClick={newChat}
				>
					<WandSparkles className="size-4" />
				</Button>
			</div>

			<button
				type="button"
				onClick={newChat}
				className="mx-3 my-2 cursor-pointer rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
			>
				New Chat
			</button>

			<div className="mx-3 flex h-10 items-center gap-2 border-b border-input">
				<Search className="size-4 text-sidebar-foreground/60" />
				<input
					type="text"
					aria-label="Search your threads"
					placeholder="Search your threads…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					className="flex-1 bg-transparent text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/50 focus:outline-none"
				/>
			</div>

			<div className="mx-3 mt-2 border-t border-border" />

			<div className="px-3 py-2 text-xs font-semibold text-primary">
				Last 30 Days
			</div>

			<ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
				{filtered.length === 0 ? (
					<li className="px-3 py-2 text-xs text-sidebar-foreground/50">
						No threads match.
					</li>
				) : (
					filtered.map((item) => (
						<li key={item.id}>
							<button
								type="button"
								onClick={() => setFocusedThread(item.id)}
								aria-current={item.id === focusedThreadId ? "true" : undefined}
								className={cn(
									"flex h-9 w-full cursor-pointer items-center truncate rounded-lg px-3 text-left text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent",
									item.id === focusedThreadId && "bg-sidebar-accent",
								)}
							>
								{item.title}
							</button>
						</li>
					))
				)}
			</ul>

			<div className="flex items-center justify-between border-t border-border px-3 py-3">
				<button
					type="button"
					aria-label="Account"
					className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
				>
					H
				</button>
				<Button variant="icon" size="icon" aria-label="Invite">
					<UserPlus className="size-4" />
				</Button>
			</div>
		</aside>
	);
}
