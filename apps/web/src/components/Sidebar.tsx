import { PanelLeftClose, Search, UserPlus, WandSparkles } from "lucide-react";
import { history } from "../data/mock.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";

export function Sidebar() {
	return (
		<aside
			aria-label="Sidebar"
			className="flex h-full flex-col bg-sidebar text-sm text-sidebar-foreground"
		>
			<div className="grid h-14 grid-cols-3 items-center px-3">
				<Button variant="icon" size="icon" aria-label="Toggle sidebar">
					<PanelLeftClose className="size-4" />
				</Button>
				<div className="text-center text-base font-bold text-foreground">
					T3.chat
				</div>
				<Button
					variant="icon"
					size="icon"
					className="justify-self-end"
					aria-label="New thread"
				>
					<WandSparkles className="size-4" />
				</Button>
			</div>

			<button
				type="button"
				className="mx-3 my-2 rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
			>
				New Chat
			</button>

			<div className="mx-3 flex h-10 items-center gap-2 border-b border-input">
				<Search className="size-4 text-sidebar-foreground/60" />
				<input
					type="text"
					aria-label="Search your threads"
					placeholder="Search your threads…"
					className="flex-1 bg-transparent text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/50 focus:outline-none"
				/>
			</div>

			<div className="mx-3 mt-2 border-t border-border" />

			<div className="px-3 py-2 text-xs font-semibold text-primary">
				Last 30 Days
			</div>

			<ul className="flex flex-1 flex-col gap-0.5 px-2">
				{history.map((item, i) => (
					<li
						key={item.id}
						className={cn(
							"flex h-9 cursor-default items-center truncate rounded-lg px-3 text-sm text-sidebar-foreground hover:bg-sidebar-accent",
							i === 0 && "bg-sidebar-accent",
						)}
					>
						{item.prompt}
					</li>
				))}
			</ul>

			<div className="flex items-center justify-between border-t border-border px-3 py-3">
				<div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
					H
				</div>
				<Button variant="icon" size="icon" aria-label="Invite">
					<UserPlus className="size-4" />
				</Button>
			</div>
		</aside>
	);
}
