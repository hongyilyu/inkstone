import { Dialog } from "@base-ui-components/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import { CornerDownLeft, MessageSquareText } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import { useMessageSearch } from "@/lib/hooks/useMessageSearch";
import { useThreads } from "@/lib/hooks/useThreads";
import {
	KIND_META,
	KIND_ORDER,
	type LibraryItem,
	libraryItemSubtitle,
	libraryItemTitle,
	recentlyCapturedItems,
	searchLibraryItems,
} from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { closeCommand, toggleCommand, useCommandOpen } from "@/store/command";
import { EntityGlyph } from "./library/EntityGlyph.js";
import { SearchField } from "./ui/search-field.js";

type Result =
	| { type: "thread"; id: string; title: string }
	| { type: "library-item"; item: LibraryItem }
	| {
			type: "message";
			thread_id: string;
			message_id: string;
			snippet: string;
			thread_title: string;
	  };

interface Group {
	key: string;
	label: string;
	items: Result[];
}

/** Debounce a fast-changing value (e.g. keystrokes) so the server message search fires once typing settles, not per keystroke. */
function useDebounced<T>(value: T, delayMs: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(t);
	}, [value, delayMs]);
	return debounced;
}

/** Global command palette (⌘K / Ctrl+K) searching recent Threads and Library items, grouped and keyboard driven; mounted once in `__root`. */
export function CommandPalette() {
	const open = useCommandOpen();
	const navigate = useNavigate();
	const { data: libraryItems } = useLibraryItems();
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();

	// Toggle on ⌘K / Ctrl+K from anywhere.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				toggleCommand();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Lazy: fetch threads only while open (shares the sidebar cache); errors → empty list.
	const { data: threadData } = useThreads({ enabled: open });

	// Debounce keystrokes so server message search fires once typing settles; the
	// query is disabled for an empty input, so an empty palette makes no server call.
	const debouncedQuery = useDebounced(query, 180);
	const { data: messageData } = useMessageSearch(debouncedQuery);

	const groups = useMemo<Group[]>(() => {
		const all = libraryItems ?? [];
		const q = query.trim().toLowerCase();
		const threads = threadData?.threads ?? [];
		const threadItems: Result[] = (
			q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads
		)
			.slice(0, 5)
			.map((t) => ({ type: "thread", id: t.id, title: t.title }));

		const matched = q
			? searchLibraryItems(all, query)
			: recentlyCapturedItems(all, 8);

		// Gate the Messages group on the DEBOUNCED query, not the immediate `q`:
		// `messageData` is keyed on `debouncedQuery`, so showing it under the
		// immediate `q` would render hits for the previous query during the debounce
		// window — a stale row that Enter/click could navigate to. Tying display to
		// the same query the data was fetched for keeps the group self-consistent.
		const dq = debouncedQuery.trim();
		const messageItems: Result[] = (dq ? (messageData?.hits ?? []) : []).map(
			(hit): Result => ({
				type: "message",
				thread_id: hit.thread_id,
				message_id: hit.message_id,
				snippet: hit.snippet,
				thread_title: hit.thread_title,
			}),
		);

		const out: Group[] = [
			{ key: "thread", label: "Threads", items: threadItems },
			{ key: "message", label: "Messages", items: messageItems },
			...KIND_ORDER.map((kind) => ({
				key: kind,
				label: KIND_META[kind].plural,
				items: matched
					.filter((e) => e.kind === kind)
					.map((item): Result => ({ type: "library-item", item })),
			})),
		];
		return out.filter((g) => g.items.length > 0);
	}, [libraryItems, threadData, messageData, query, debouncedQuery]);

	const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

	// Reset transient state every time the palette opens; focus the input.
	useEffect(() => {
		if (open) {
			setQuery("");
			setActive(0);
			const t = setTimeout(() => inputRef.current?.focus(), 0);
			return () => clearTimeout(t);
		}
	}, [open]);

	useEffect(() => {
		const el = listRef.current?.querySelector<HTMLElement>(
			`[data-index="${active}"]`,
		);
		el?.scrollIntoView?.({ block: "nearest" });
	}, [active]);

	const activate = (result: Result | undefined) => {
		if (!result) return;
		closeCommand();
		if (result.type === "thread") {
			navigate({ to: "/thread/$threadId", params: { threadId: result.id } });
			return;
		}
		if (result.type === "message") {
			// Deep-link to the Thread AND the within-thread anchor (ADR-0042): the
			// `?focusedMessageId` param tells ChatColumn to scroll the matched Message
			// into view and briefly highlight it once hydrated (issue #138), then
			// strips itself (consume-then-strip).
			navigate({
				to: "/thread/$threadId",
				params: { threadId: result.thread_id },
				search: { focusedMessageId: result.message_id },
			});
			return;
		}
		const item = result.item;
		navigate({
			to: "/library/$kind",
			params: { kind: KIND_META[item.kind].slug },
			search: { id: item.id },
		});
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			activate(flat[active]);
		}
	};

	let runningIndex = -1;

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) closeCommand();
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/25 backdrop-blur-[2px] transition-opacity duration-200 motion-reduce:transition-none data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
				<Dialog.Popup
					aria-label="Search"
					className="-translate-x-1/2 fixed top-[12vh] left-1/2 z-50 flex max-h-[68vh] w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl outline-none transition-[opacity,transform] duration-200 motion-reduce:transition-none data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
				>
					<Dialog.Title className="sr-only">Search</Dialog.Title>
					<SearchField
						variant="dialog"
						inputRef={inputRef}
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setActive(0);
						}}
						onKeyDown={onKeyDown}
						role="combobox"
						aria-expanded
						aria-controls={listboxId}
						aria-activedescendant={
							flat.length > 0 ? `${listboxId}-opt-${active}` : undefined
						}
						placeholder="Search threads, people, projects, todos…"
					/>

					<div
						ref={listRef}
						id={listboxId}
						role="listbox"
						aria-label="Results"
						className="min-h-0 flex-1 overflow-y-auto p-2"
					>
						{flat.length === 0 ? (
							<p className="px-3 py-10 text-center text-muted-foreground text-sm">
								{query.trim()
									? `No matches for "${query.trim()}".`
									: "Type to search your workspace."}
							</p>
						) : (
							groups.map((group) => (
								<div key={group.key} className="mb-1 last:mb-0">
									<div className="px-3 pt-2 pb-1 font-medium text-muted-foreground text-xs">
										{group.label}
									</div>
									{group.items.map((item) => {
										runningIndex += 1;
										const index = runningIndex;
										const isActive = index === active;
										return (
											<button
												key={
													item.type === "thread"
														? `t-${item.id}`
														: item.type === "message"
															? `m-${item.message_id}`
															: item.item.id
												}
												type="button"
												id={`${listboxId}-opt-${index}`}
												data-index={index}
												role="option"
												aria-selected={isActive}
												onMouseMove={() => setActive(index)}
												onClick={() => activate(item)}
												className={cn(
													"flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left",
													isActive ? "bg-accent" : "bg-transparent",
												)}
											>
												{item.type === "thread" ? (
													<>
														<span
															className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
															aria-hidden
														>
															<MessageSquareText className="size-4" />
														</span>
														<span className="min-w-0 flex-1 truncate text-foreground text-sm">
															{item.title}
														</span>
													</>
												) : item.type === "message" ? (
													<>
														<span
															className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
															aria-hidden
														>
															<MessageSquareText className="size-4" />
														</span>
														<span className="min-w-0 flex-1">
															<span className="block truncate text-foreground text-sm">
																{item.snippet}
															</span>
															<span className="block truncate text-muted-foreground text-xs">
																{item.thread_title}
															</span>
														</span>
													</>
												) : (
													<>
														<EntityGlyph entity={item.item} size="sm" />
														<span className="min-w-0 flex-1">
															<span className="block truncate text-foreground text-sm">
																{libraryItemTitle(item.item)}
															</span>
															<span className="block truncate text-muted-foreground text-xs">
																{libraryItemSubtitle(item.item)}
															</span>
														</span>
													</>
												)}
												{isActive ? (
													<CornerDownLeft
														className="size-3.5 shrink-0 text-muted-foreground"
														aria-hidden
													/>
												) : null}
											</button>
										);
									})}
								</div>
							))
						)}
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
