// VISUAL ONLY — automations are out of scope per ADR-0010; rendered from mock data.
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { automations, history, type RunHistoryItem } from "../data/mock.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";

const today = history.slice(0, 1);
const week = history.slice(1, 4);
const older = history.slice(4);

export function Sidebar() {
	const [automationsOpen, setAutomationsOpen] = useState(false);

	return (
		<aside
			aria-label="Sidebar"
			className="flex flex-col gap-4 bg-sidebar py-3 text-sm text-sidebar-foreground"
		>
			<HistorySection label="Today" items={today} />
			<HistorySection label="This week" items={week} />
			<HistorySection label="Older" items={older} />

			<div className="px-2">
				<Button
					variant="sidebar-item"
					size="row"
					className="w-full text-xs font-semibold text-sidebar-foreground/70"
					aria-expanded={automationsOpen}
					onClick={() => setAutomationsOpen((open) => !open)}
				>
					<ChevronRight
						className={cn(
							"size-4 transition-transform",
							automationsOpen && "rotate-90",
						)}
					/>
					Automations
				</Button>
				{automationsOpen ? (
					<ul className="mt-1 flex flex-col gap-0.5 pl-6">
						{automations.map((a) => (
							<li
								key={a.id}
								className="flex h-9 cursor-default items-center truncate rounded-lg px-2 py-1 text-sm text-foreground hover:bg-sidebar-accent"
							>
								{a.name}
							</li>
						))}
					</ul>
				) : null}
			</div>
		</aside>
	);
}

function HistorySection({
	label,
	items,
}: {
	label: string;
	items: RunHistoryItem[];
}) {
	if (items.length === 0) return null;
	return (
		<div className="flex flex-col gap-0.5">
			<div className="px-3 py-1 text-xs font-semibold text-sidebar-foreground/70">
				{label}
			</div>
			<ul className="flex flex-col gap-0.5 px-2">
				{items.map((item) => (
					<li
						key={item.id}
						className="flex h-9 cursor-default items-center truncate rounded-lg px-2 py-1 text-sm hover:bg-sidebar-accent"
					>
						{item.prompt}
					</li>
				))}
			</ul>
		</div>
	);
}
