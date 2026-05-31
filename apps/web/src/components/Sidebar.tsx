// VISUAL ONLY — automations are out of scope per ADR-0010; rendered from mock data.
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { automations, history, type RunHistoryItem } from "../data/mock.js";
import { cn } from "../lib/utils.js";

const today = history.slice(0, 1);
const week = history.slice(1, 4);
const older = history.slice(4);

export function Sidebar() {
	const [automationsOpen, setAutomationsOpen] = useState(false);

	return (
		<aside
			aria-label="Sidebar"
			className="flex flex-col gap-4 border-r border-border bg-background py-3 text-sm"
		>
			<HistorySection label="Today" items={today} />
			<HistorySection label="This week" items={week} />
			<HistorySection label="Older" items={older} />

			<div className="px-1">
				<button
					type="button"
					aria-expanded={automationsOpen}
					onClick={() => setAutomationsOpen((open) => !open)}
					className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-muted/50"
				>
					<ChevronRight
						className={cn(
							"size-4 transition-transform",
							automationsOpen && "rotate-90",
						)}
					/>
					Automations
				</button>
				{automationsOpen ? (
					<ul className="mt-1 flex flex-col gap-0.5 pl-6">
						{automations.map((a) => (
							<li
								key={a.id}
								className="cursor-default truncate rounded-md px-3 py-1.5 text-sm text-foreground hover:bg-muted/50"
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
			<div className="px-4 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{label}
			</div>
			<ul className="flex flex-col gap-0.5 px-1">
				{items.map((item) => (
					<li
						key={item.id}
						className="cursor-default truncate rounded-md px-3 py-1.5 text-sm hover:bg-muted/50"
					>
						{item.prompt}
					</li>
				))}
			</ul>
		</div>
	);
}
