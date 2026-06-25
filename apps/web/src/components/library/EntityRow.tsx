import { Popover } from "@base-ui-components/react/popover";
import {
	AlertTriangle,
	CalendarClock,
	Circle,
	CircleCheck,
	CircleSlash,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { buildTodo, todoDraftFromVm } from "@/lib/entityCodec";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import {
	addDays,
	type LibraryItem,
	libraryItemSubtitle,
	libraryItemTitle,
	localNowString,
	projectForTodo,
	type Todo,
	todoIsOverdue,
} from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { EditorInput } from "./EntityEditor.js";
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
 * A quick-defer menu for an ACTIVE todo: Tomorrow / Next week / Pick a date…,
 * each firing a direct `update_todo` that restamps `defer_at` (ADR-0033, same
 * write path as the complete circle). Reuses the editor's exact diff/format path
 * via `buildTodo({mode:"update"})` so the wire shape stays single-sourced; the
 * trigger reveals on hover/focus but stays focusable so it's reachable.
 */
function QuickDeferMenu({ todo }: { todo: Todo }) {
	const mutation = useEntityMutation();
	const [open, setOpen] = useState(false);
	const [picking, setPicking] = useState(false);

	const defer = (day: string) => {
		if (mutation.isPending) return;
		const params = buildTodo({
			mode: "update",
			existing: todo,
			baseline: todoDraftFromVm(todo),
			draft: { ...todoDraftFromVm(todo), deferDay: day },
		});
		if (params) mutation.mutate(params);
		setOpen(false);
		setPicking(false);
	};

	return (
		<Popover.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setPicking(false);
			}}
		>
			<Popover.Trigger
				render={
					<button
						type="button"
						aria-label="Defer todo"
						className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-primary focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring group-focus-within:opacity-100 group-hover:opacity-100"
					>
						<CalendarClock className="size-[18px]" aria-hidden />
					</button>
				}
			/>
			<Popover.Portal>
				<Popover.Positioner side="bottom" align="end" sideOffset={6}>
					<Popover.Popup className="w-44 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
						<ul className="flex flex-col gap-0.5">
							<li>
								<button
									type="button"
									onClick={() => defer(addDays(1))}
									className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
								>
									Tomorrow
								</button>
							</li>
							<li>
								<button
									type="button"
									onClick={() => defer(addDays(7))}
									className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
								>
									Next week
								</button>
							</li>
							<li>
								{picking ? (
									<EditorInput
										type="date"
										aria-label="Defer to a specific date"
										// biome-ignore lint/a11y/noAutofocus: focus the revealed picker so a keyboard user lands on it
										autoFocus
										onChange={(e) => {
											if (e.target.value) defer(e.target.value);
										}}
									/>
								) : (
									<button
										type="button"
										onClick={() => setPicking(true)}
										className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
									>
										Pick a date…
									</button>
								)}
							</li>
						</ul>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
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
	onQuickDefer,
}: {
	todo: Todo;
	allItems?: LibraryItem[];
	selected?: boolean;
	onSelect: (id: string) => void;
	/** Opt the row into the inline-complete circle. Absent → read-only glyph. */
	onComplete?: (id: string) => void;
	/** Opt the row into the quick-defer menu (active rows only). The row's own
	 * hook does the write — this marker just turns the control on. */
	onQuickDefer?: (id: string) => void;
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
			{onQuickDefer && todo.status === "active" ? (
				<span className="flex shrink-0 items-center">
					<QuickDeferMenu todo={todo} />
				</span>
			) : null}
		</li>
	);
}
