import { AlertTriangle, Circle, CircleCheck, CircleSlash } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
	type LibraryItem,
	libraryItemSubtitle,
	libraryItemTitle,
	projectForTodo,
	type Todo,
	todoIsOverdue,
} from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { EntityGlyph } from "./EntityGlyph.js";

/** Generic, selectable row: glyph + title + subtitle, optional trailing slot. */
export function EntityRow({
	entity,
	selected,
	onSelect,
	trailing,
}: {
	entity: LibraryItem;
	selected?: boolean;
	onSelect: (id: string) => void;
	trailing?: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(entity.id)}
			aria-current={selected ? "true" : undefined}
			className={cn(
				"flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
				"focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
				selected ? "bg-secondary/70" : "hover:bg-secondary/40",
			)}
		>
			<EntityGlyph entity={entity} size="sm" />
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-foreground text-sm">
					{libraryItemTitle(entity)}
				</span>
				<span className="block truncate text-muted-foreground text-xs">
					{libraryItemSubtitle(entity)}
				</span>
			</span>
			{trailing}
		</button>
	);
}

/** Small due pill. Overdue carries an icon + label, never colour alone. */
export function DueChip({ due, overdue }: { due: string; overdue: boolean }) {
	return (
		<Badge
			variant={overdue ? "destructive" : "secondary"}
			size="sm"
			className="shrink-0"
		>
			{overdue ? <AlertTriangle className="size-3" aria-hidden /> : null}
			{overdue ? "Overdue" : due}
		</Badge>
	);
}

/** Read-only status mark for a Todo row — completed/dropped/active, label not colour alone. */
function TodoStatusGlyph({ todo }: { todo: Todo }) {
	if (todo.status === "completed") {
		return (
			<CircleCheck
				className="size-[18px] text-primary"
				aria-label="Completed"
			/>
		);
	}
	if (todo.status === "dropped") {
		return (
			<CircleSlash
				className="size-[18px] text-muted-foreground"
				aria-label="Dropped"
			/>
		);
	}
	return (
		<Circle className="size-[18px] text-muted-foreground" aria-label="Active" />
	);
}

/** Todo row: a read-only status mark plus the open affordance. Editing is deferred (ADR-0032). */
export function TodoRow({
	todo,
	allItems = [],
	selected,
	onSelect,
}: {
	todo: Todo;
	allItems?: LibraryItem[];
	selected?: boolean;
	onSelect: (id: string) => void;
}) {
	const resolved = todo.status !== "active";
	const overdue = todoIsOverdue(todo);
	const project = projectForTodo(allItems, todo);
	const context = project ? libraryItemTitle(project) : null;

	return (
		<li className="group flex items-stretch gap-1">
			<span className="flex w-9 shrink-0 items-center justify-center">
				<TodoStatusGlyph todo={todo} />
			</span>
			<button
				type="button"
				onClick={() => onSelect(todo.id)}
				aria-current={selected ? "true" : undefined}
				className={cn(
					"flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
					"focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
					selected ? "bg-secondary/70" : "hover:bg-secondary/40",
				)}
			>
				<span className="min-w-0 flex-1">
					<span
						className={cn(
							"block truncate text-sm",
							resolved
								? "text-muted-foreground line-through"
								: "font-medium text-foreground",
						)}
					>
						{todo.title}
					</span>
					<span className="block truncate text-muted-foreground text-xs">
						{context || "No project"}
					</span>
				</span>
				{todo.dueAt ? (
					<DueChip due={todo.dueAt.slice(0, 10)} overdue={overdue} />
				) : null}
			</button>
		</li>
	);
}
