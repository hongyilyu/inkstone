import { useParams } from "@tanstack/react-router";
import { Archive, Library, Pencil, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input.js";
import { NavShell, navRow } from "@/components/ui/nav-shell";
import { useCopyToClipboard } from "@/lib/hooks/useCopyToClipboard";
import { useThreadMutations } from "@/lib/hooks/useThreadMutations";
import { useThreads } from "@/lib/hooks/useThreads";
import { openCommand } from "@/store/command";
import { cn } from "../lib/utils.js";
import { CopyOutcome } from "./CopyOutcome.js";

export function Sidebar({
	onOpenLibrary,
	onOpenArchived,
	onOpenSettings,
	onOpenThread,
	onNewChat,
}: {
	onOpenLibrary?: () => void;
	onOpenArchived?: () => void;
	onOpenSettings?: () => void;
	onOpenThread?: (threadId: string) => void;
	onNewChat?: () => void;
} = {}) {
	// The focused Thread is the route (ADR-0061); read it to mark the current row.
	const { threadId } = useParams({ strict: false });
	const focusedThreadId = threadId ?? null;

	// Reads via TanStack Query; live stream stays on store+bridge (ADR-0020).
	const { data, isPending, isError } = useThreads();

	const threads = data?.threads ?? [];
	const groups = groupByRecency(threads);

	return (
		<NavShell as="aside" ariaLabel="Sidebar" onOpenSettings={onOpenSettings}>
			<div className="flex flex-col gap-0.5">
				<button
					type="button"
					onClick={onOpenLibrary}
					className={cn(navRow, "w-full")}
				>
					<Library className="size-4 shrink-0" aria-hidden />
					Library
				</button>
				<button
					type="button"
					onClick={onOpenArchived}
					className={cn(navRow, "w-full")}
				>
					<Archive className="size-4 shrink-0" aria-hidden />
					Archived
				</button>
				<button
					type="button"
					onClick={openCommand}
					className={cn(navRow, "w-full")}
				>
					<Search className="size-4 shrink-0" aria-hidden />
					<span className="flex-1 text-left">Search</span>
					<kbd className="rounded border border-sidebar-foreground/15 px-1.5 py-0.5 font-medium font-sans text-[10px] text-sidebar-foreground/50">
						⌘K
					</kbd>
				</button>
			</div>

			<div className="mx-3 my-3 border-border border-t" />

			<button
				type="button"
				onClick={onNewChat}
				className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg bg-secondary px-3 text-left font-semibold text-secondary-foreground text-sm transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_12%,var(--secondary))] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
			>
				<Plus className="size-4 shrink-0" aria-hidden />
				New Chat
			</button>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{isError && threads.length === 0 ? (
					// A failed `thread/list` with NO cached rows (cold load, Core down)
					// must NOT read as a genuinely empty workspace — a returning user with
					// real threads would be told their conversations vanished. Show an
					// honest load-failure. (If a later refetch fails but TanStack still has
					// cached rows, we fall through and keep the stale-but-usable list rather
					// than blanking navigation.)
					<p className="px-3 pt-3 text-muted-foreground text-xs">
						Couldn't load your conversations. Check that Inkstone is running.
					</p>
				) : isPending ? (
					// Fetch in flight: stay quiet rather than flashing the empty copy.
					<p className="px-3 pt-3 text-muted-foreground text-xs">Loading…</p>
				) : threads.length === 0 ? (
					<p className="px-3 pt-3 text-muted-foreground text-xs">
						No threads yet.
					</p>
				) : (
					groups.map((group) => (
						<section key={group.label}>
							<h2 className="sticky top-0 z-10 bg-sidebar px-3 pt-3 pb-1 font-semibold text-muted-foreground text-xs">
								{group.label}
							</h2>
							<ul className="flex flex-col gap-1">
								{group.threads.map((item) => (
									<ThreadRow
										key={item.id}
										item={item}
										isCurrent={item.id === focusedThreadId}
										onOpenThread={onOpenThread}
										onReselect={onNewChat}
									/>
								))}
							</ul>
						</section>
					))
				)}
			</div>
		</NavShell>
	);
}

/** One sidebar Thread row. Owns inline-rename state (double-click the title →
 * `<Input>`; Enter/blur commit a trimmed, *changed* title via `threadRename`;
 * Escape restores and exits — empty or unchanged is a no-op) and the archive
 * action. While editing, the row does NOT navigate. */
function ThreadRow({
	item,
	isCurrent,
	onOpenThread,
	onReselect,
}: {
	item: Thread;
	isCurrent: boolean;
	onOpenThread?: (threadId: string) => void;
	onReselect?: () => void;
}) {
	const { rename, archive } = useThreadMutations();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(item.title);

	const beginEdit = () => {
		setDraft(item.title);
		// Clear any stale rename OR archive failure — both feed `rowError`, so a
		// prior archive error would otherwise linger under the rename input.
		rename.reset();
		archive.reset();
		setEditing(true);
	};

	const commit = () => {
		const trimmed = draft.trim();
		// Empty or unchanged is a no-op (Core rejects an empty title anyway).
		if (!trimmed || trimmed === item.title) {
			setEditing(false);
			return;
		}
		// Keep the row in edit mode until the write succeeds: on failure the typed
		// title must NOT be silently discarded (the row would re-render the old
		// `item.title`). onSuccess closes; onError leaves the input open with its
		// value intact so the inline alert below explains why and the user retries.
		rename.mutate(
			{ threadId: item.id, title: trimmed },
			{ onSuccess: () => setEditing(false) },
		);
	};

	const cancel = () => {
		rename.reset();
		setEditing(false);
	};

	// A failed rename/archive must not be silent: surface the squashed WsError
	// message inline (this app has no toast surface by design — mirror the inline
	// error pattern useEntityMutation callers use).
	const rowError =
		(rename.isError && "Couldn't rename this conversation. Try again.") ||
		(archive.isError && "Couldn't archive this conversation. Try again.") ||
		null;

	return (
		<li
			className={cn(
				"group relative flex flex-col rounded-lg transition-colors",
				isCurrent ? "bg-secondary/70" : "hover:bg-primary/10",
			)}
		>
			<div className="relative flex h-10 items-center pr-1">
				{isCurrent && (
					<span
						aria-hidden="true"
						className="pointer-events-none absolute top-1/2 left-2 size-[5px] -translate-y-1/2 rounded-full bg-primary"
					/>
				)}
				{editing ? (
					<Input
						autoFocus
						aria-label={`Rename thread ${item.title}`}
						aria-invalid={rename.isError || undefined}
						value={draft}
						disabled={rename.isPending}
						onChange={(e) => {
							setDraft(e.target.value);
							// Clear a prior failure as the user corrects the title — the
							// stale error must not keep gating blur-commit (below) or linger
							// as a stale alarm over new input.
							if (rename.isError) rename.reset();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") commit();
							else if (e.key === "Escape") cancel();
						}}
						// Commit on blur EXCEPT while a rename is in flight or already
						// failed — a failed rename keeps the input open so the blur that
						// fires when focus moves to the alert doesn't re-fire the mutation.
						// (onChange clears isError, so editing then blurring commits again.)
						onBlur={() => {
							if (!rename.isPending && !rename.isError) commit();
						}}
						className="h-full min-w-0 flex-1 rounded-lg py-0 pr-3 pl-[18px] text-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
					/>
				) : (
					<button
						type="button"
						onClick={() => onOpenThread?.(item.id)}
						onDoubleClick={beginEdit}
						aria-current={isCurrent ? "true" : undefined}
						// Long titles clip with CSS `truncate`; a native tooltip
						// reveals the full title (a generated title, or the
						// prompt-derived fallback slug — ADR-0048) on hover
						// without a layout shift.
						title={item.title}
						className={cn(
							"h-full min-w-0 flex-1 cursor-pointer truncate rounded-lg py-0 pr-3 pl-[18px] text-left text-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
							isCurrent
								? "font-semibold text-secondary-foreground"
								: "text-sidebar-foreground",
						)}
					>
						{item.title}
					</button>
				)}
				{!editing && (
					<>
						<RenameThreadButton title={item.title} onRename={beginEdit} />
						<ArchiveThreadButton
							title={item.title}
							onArchive={() =>
								// Reselect fires on the mutation's SUCCESS, not synchronously:
								// archiving the focused Thread (ADR-0061 — focus IS the route)
								// must drop us off `/thread/$id`. Reuse `onNewChat` (wired to
								// navigate({to:"/"}) in _chat.tsx) — landing on the welcome route
								// is exactly the reselect we want, so no extra nav prop.
								archive.mutate(item.id, {
									onSuccess: () => {
										if (isCurrent) onReselect?.();
									},
								})
							}
						/>
						<CopyThreadIdButton id={item.id} title={item.title} />
					</>
				)}
			</div>
			{rowError && (
				<p role="alert" className="px-[18px] pb-1.5 text-destructive text-xs">
					{rowError}
				</p>
			)}
		</li>
	);
}

/** The per-row hover-reveal rename control — a keyboard- and touch-reachable path
 * to inline rename (double-click is a mouse-only affordance; ADR-0052). Mirrors
 * {@link ArchiveThreadButton}'s slot + reveal treatment. */
function RenameThreadButton({
	title,
	onRename,
}: {
	title: string;
	onRename: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={`Rename thread ${title}`}
			title="Rename"
			onClick={onRename}
			className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/80 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
		>
			<Pencil className="size-4" aria-hidden />
		</button>
	);
}

/** The per-row hover-reveal archive control (mirrors {@link CopyThreadIdButton}'s
 * slot + reveal treatment). Archive is reversible (ADR-0052) so there's no confirm
 * dialog. */
function ArchiveThreadButton({
	title,
	onArchive,
}: {
	title: string;
	onArchive: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={`Archive thread ${title}`}
			title="Archive"
			onClick={onArchive}
			className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/80 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
		>
			<Archive className="size-4" aria-hidden />
		</button>
	);
}

/** The per-row "copy thread id" control: writes the id to the clipboard and
 * flips to a checkmark for ~1.5s so the click has visible confirmation (without
 * this, nothing changed on copy and the user couldn't tell it worked). Reuses
 * {@link useCopyToClipboard} so the checkmark only shows on a write that actually
 * succeeded — a denied/unavailable clipboard shows the X, never a fake success.
 * The aria-label stays `Copy thread id for <title>` so existing tests/e2e
 * selectors and screen-reader users keep their stable name. */
function CopyThreadIdButton({ id, title }: { id: string; title: string }) {
	const { copied, failed, copy } = useCopyToClipboard(1500);
	return (
		<button
			type="button"
			aria-label={`Copy thread id for ${title}`}
			title={copied ? "Copied" : failed ? "Couldn't copy" : "Copy thread id"}
			onClick={() => {
				void copy(id);
			}}
			className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/80 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
		>
			{/* Icon swap + screen-reader announcement shared with CopyButton. */}
			<CopyOutcome copied={copied} failed={failed} />
		</button>
	);
}

type Thread = { id: string; title: string; last_activity_at: number };

/** Buckets threads by recency (newest first) into Today / Yesterday / Earlier this week / Older on local-calendar-day boundaries; empty groups dropped. */
function groupByRecency(
	threads: readonly Thread[],
	now: number = Date.now(),
): { label: string; threads: Thread[] }[] {
	// Compute each boundary as an actual local calendar day (subtract N days on a
	// Date, not N * 86.4M ms). A fixed-ms step lands an hour off across a DST
	// transition, which can misbucket a thread near midnight into the wrong day.
	const startOfToday = new Date(now).setHours(0, 0, 0, 0);
	const dayStart = (daysAgo: number) => {
		const d = new Date(startOfToday);
		d.setDate(d.getDate() - daysAgo);
		return d.getTime();
	};
	const startOfYesterday = dayStart(1);
	const startOfWeek = dayStart(6);

	const groups: { label: string; threads: Thread[] }[] = [
		{ label: "Today", threads: [] },
		{ label: "Yesterday", threads: [] },
		{ label: "Earlier this week", threads: [] },
		{ label: "Older", threads: [] },
	];

	for (const t of threads) {
		const at = t.last_activity_at;
		if (at >= startOfToday) groups[0].threads.push(t);
		else if (at >= startOfYesterday) groups[1].threads.push(t);
		else if (at >= startOfWeek) groups[2].threads.push(t);
		else groups[3].threads.push(t);
	}

	return groups.filter((g) => g.threads.length > 0);
}
