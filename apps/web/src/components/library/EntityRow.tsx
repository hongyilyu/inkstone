import { AlertTriangle, Circle, CircleCheck, CircleSlash } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import {
	type LibraryItem,
	libraryItemSubtitle,
	libraryItemTitle,
	localNowString,
	projectForTodo,
	type Todo,
	todoIsOverdue,
} from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { EntityGlyph } from "./EntityGlyph.js";

/** Generic, selectable row: glyph + title + subtitle. */
export function EntityRow({
	entity,
	selected,
	onSelect,
}: {
	entity: LibraryItem;
	selected?: boolean;
	onSelect: (id: string) => void;
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
			{/* Keep the date even when overdue so multiple overdue rows stay
			    distinguishable (matches EntityDetail's "Overdue · <date>"). */}
			{overdue ? `Overdue · ${due}` : due}
		</Badge>
	);
}

/** Small "not before" pill — when a deferred Todo becomes available. Plain, never
 * destructive. Takes the `YYYY-MM-DD` day slice, matching `DueChip`'s date format
 * so a row carrying both pills reads consistently. */
function DeferChip({ defer }: { defer: string }) {
	return (
		<Badge variant="secondary" size="sm" className="shrink-0">
			Available {defer}
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

/**
 * An interactive status circle that completes an ACTIVE todo in one click via a
 * direct `update_todo` (status=completed + completed_at), per ADR-0033/0034.
 * Lives in the same `w-9` slot as the read-only glyph; its own button so it does
 * not nest inside the row's selecting body button. Optimistic: the circle flips
 * to CircleCheck on success before the `["library-items"]` refetch lands.
 */
function CompleteCircle({ todo }: { todo: Todo }) {
	const mutation = useEntityMutation();
	const done = todo.status === "completed" || mutation.isSuccess;

	const complete = () => {
		if (done || mutation.isPending) return;
		mutation.mutate({
			mutation_kind: "update_todo",
			payload: {
				todo_id: todo.id,
				todo: { status: "completed", completed_at: localNowString() },
			},
		});
	};

	return (
		<button
			type="button"
			onClick={complete}
			disabled={done || mutation.isPending}
			aria-label={done ? "Completed" : "Mark todo complete"}
			className="rounded-full focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
		>
			{done ? (
				<CircleCheck className="size-[18px] text-primary" aria-hidden />
			) : (
				<Circle
					className="size-[18px] text-muted-foreground transition-colors hover:text-primary"
					aria-hidden
				/>
			)}
		</button>
	);
}

/**
 * Todo row: the status mark plus the open affordance. When `onComplete` is wired
 * AND the todo is active, the status mark is an interactive complete circle
 * (user-initiated direct write, ADR-0033/0034); otherwise it's the read-only
 * glyph — resolved rows and rows with no inline action stay read-only.
 */
export function TodoRow({
	todo,
	allItems = [],
	selected,
	onSelect,
	onComplete,
}: {
	todo: Todo;
	allItems?: LibraryItem[];
	selected?: boolean;
	onSelect: (id: string) => void;
	/** Opt the row into the inline-complete circle. Absent → read-only glyph. */
	onComplete?: (id: string) => void;
}) {
	const resolved = todo.status !== "active";
	const overdue = todoIsOverdue(todo);
	const project = projectForTodo(allItems, todo);
	const context = project ? libraryItemTitle(project) : null;

	return (
		<li className="group flex items-stretch gap-1">
			<span className="flex w-9 shrink-0 items-center justify-center">
				{onComplete && todo.status === "active" ? (
					<CompleteCircle todo={todo} />
				) : (
					<TodoStatusGlyph todo={todo} />
				)}
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
				{todo.deferAt ? <DeferChip defer={todo.deferAt.slice(0, 10)} /> : null}
			</button>
		</li>
	);
}
