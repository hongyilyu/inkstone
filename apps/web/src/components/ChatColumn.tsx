import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
	MessageSquareDashed,
	RotateCcw,
	Sparkles,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRuntime } from "@/runtime";
import {
	cancelRun,
	send,
	sendNewThread,
	startProposalStream,
} from "@/store/bridge";
import {
	concatText,
	type Message,
	type Segment,
	type ToolCall,
	useActiveRunId,
	useHydrationStatus,
	useThreadMessages,
} from "@/store/chat";
import { hydrateThread, useHydrateFocusedThread } from "@/store/hydrate";
import { AssistantProposals } from "./AssistantProposals.js";
import { ChatMarkdown } from "./ChatMarkdown.js";
import { ComposeFooter } from "./ComposeFooter.js";
import { CopyButton } from "./CopyButton.js";
import { ToolActivity } from "./ToolActivity.js";
import { Button } from "./ui/button.js";
import { EmptyState } from "./ui/empty-state.js";

export function ChatColumn() {
	const scrollerRef = useRef<HTMLDivElement>(null);
	const runtime = useRuntime();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	// The focused Thread is the route (ADR-0042): `/thread/$threadId` carries the
	// id, `/` (welcome) has none. `strict: false` lets one component serve both —
	// the Library reads its `$kind` the same way (routes/library/route.tsx).
	const { threadId } = useParams({ strict: false });
	const focusedThreadId = threadId ?? null;
	const messages = useThreadMessages(focusedThreadId ?? "");
	// Set while a Run streams AND while it's parked awaiting a Proposal (only a
	// terminal Run Event clears it) — so Stop covers both, matching run/cancel.
	const activeRunId = useActiveRunId(focusedThreadId ?? "");
	const hydration = useHydrationStatus(focusedThreadId ?? "");
	const [sendError, setSendError] = useState<string | null>(null);
	// The Message a ⌘K search hit jumped to (issue #138): scrolled into view and
	// briefly ringed once its row is in the DOM. The URL search param is the
	// pending jump (ADR-0042); `highlightId` is the transient visual that lingers
	// ~1.6s then fades. `strict: false` so the / (welcome) route — which has no
	// search schema — reads `undefined` rather than throwing.
	const { focusedMessageId } = useSearch({ strict: false }) as {
		focusedMessageId?: string;
	};
	const [highlightId, setHighlightId] = useState<string | null>(null);

	// No thread focused → fresh chat. Focused + empty: the reactive hydration status (issue #108) decides —
	// skeleton only while the fetch is genuinely in flight (or about to fire), a recoverable error if it failed
	// (never an eternal skeleton), and the message list otherwise (PRODUCT.md "show the state, not a spinner").
	const noMessages = messages.length === 0;
	const showWelcome = focusedThreadId === null && noMessages;
	const hydrationFailed =
		focusedThreadId !== null && noMessages && hydration === "error";
	// A Thread the URL points at that Core says doesn't exist (stale shared link,
	// deleted Thread): an honest dead-end, not a retry (ADR-0042). `noMessages` is
	// not required — a missing Thread never has messages — but keeps the branch
	// symmetric with the others.
	const threadNotFound =
		focusedThreadId !== null && noMessages && hydration === "not_found";
	const showHydrating =
		focusedThreadId !== null &&
		noMessages &&
		(hydration === null || hydration === "loading");

	// Hydrate on focus change; no-op for locally-originated (pre-marked) threads. See docs/design/web-chat-ui.md.
	useHydrateFocusedThread(runtime, focusedThreadId);

	// Consume the global proposal/* stream once for the chat surface (ADR-0025). Idempotent.
	useEffect(() => {
		startProposalStream(runtime);
	}, [runtime]);

	// The thread whose initial scroll has already been placed — guards the
	// cold-load bottom-scroll so it fires once per thread-load, not on every
	// streamed delta (ADR-0042). The anchor effect below also stamps it, so a
	// consumed deep-link counts as that thread's initial scroll and the bottom
	// effect can't clobber the just-completed jump.
	const initialScrollThread = useRef<string | null>(null);

	// The anchor value whose jump has already fired. Unlike master's synchronous
	// store-anchor consume, the URL strip is an ASYNC navigate (the param lingers a
	// few renders until it commits), so without this guard a `messages` change in
	// that window — e.g. a ⌘K jump into a thread with a live streaming Run — would
	// re-fire scrollIntoView every delta and fight the user's scroll. Keyed on the
	// anchor id (not the thread) so a SECOND ⌘K hit to a different message in the
	// same thread still jumps, while a strip-window re-fire (same id) does not.
	const scrolledAnchorId = useRef<string | null>(null);

	// Cold-load / thread-switch lands at the latest message (ADR-0042). The old
	// mount-only scroll no-op'd on a cold thread (messages arrive AFTER mount), so
	// reloading onto a long thread used to land at the top. Pin to the bottom when
	// the thread's messages first render — UNLESS a `?focusedMessageId` anchor is
	// pending, which wins (the anchor effect scrolls to a specific row instead).
	// Keyed on the message list so the cold-thread path fires once thread/get
	// hydrates; the per-thread ref keeps streamed deltas from re-pinning.
	useLayoutEffect(() => {
		if (focusedMessageId !== undefined || focusedThreadId === null) return;
		if (messages.length === 0) return;
		if (initialScrollThread.current === focusedThreadId) return;
		const el = scrollerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
		initialScrollThread.current = focusedThreadId;
	}, [focusedThreadId, focusedMessageId, messages]);

	// Scroll-to-message (issue #138). Fires when the anchored Message is actually
	// present in the rendered list — the real precondition, covering both a cold
	// thread (after thread/get hydrates and repaints) and the already-focused one
	// on the same tick. Jump straight to it (no glide across deep scrollback) and
	// hand off to the lamplight ring to land the eye; the scroll itself is
	// motion-reduce-safe (`auto`, not `smooth`). Consume the anchor one-shot so a
	// later unrelated re-render can't re-scroll. `messages` is the dependency that
	// lets the cold-thread path fire once history arrives.
	useEffect(() => {
		if (focusedMessageId === undefined || focusedThreadId === null) return;
		// Consume-then-strip (ADR-0042): drop the param so a reload/re-render can't
		// re-fire the jump, replacing (not pushing) so Back doesn't land un-stripped.
		const stripAnchor = () =>
			navigate({
				to: "/thread/$threadId",
				params: { threadId: focusedThreadId },
				search: {},
				replace: true,
			});
		// The exact-match `.some()` gate already restricts the id to a real message
		// id, but `focusedMessageId` is URL-supplied, so escape it before it enters
		// the attribute selector — defense-in-depth against a value with selector
		// metacharacters (CodeRabbit).
		const target = messages.some((m) => m.id === focusedMessageId)
			? scrollerRef.current?.querySelector<HTMLElement>(
					`[data-message-id="${CSS.escape(focusedMessageId)}"]`,
				)
			: null;
		if (!target) {
			// The anchored Message isn't in the rendered list. Two cases: (a) history
			// is still arriving (hydrating) — wait for the re-fire once it lands; or
			// (b) hydration has SETTLED and the id genuinely isn't here (a stale/
			// deleted/typo'd anchor, or a server-id anchor against a warm thread's
			// client-minted ids). In case (b) the anchor is unresolvable: strip it so
			// it can't linger in the URL forever or wedge the cold-load bottom-scroll.
			const settled =
				hydration === "ready" ||
				hydration === "not_found" ||
				messages.length > 0;
			if (settled) void stripAnchor();
			return;
		}
		// True one-shot: once we've jumped for this anchor, don't re-scroll if a later
		// `messages` tick re-runs the effect while the async strip is still in flight.
		if (scrolledAnchorId.current === focusedMessageId) return;
		scrolledAnchorId.current = focusedMessageId;
		target.scrollIntoView({ block: "center", behavior: "auto" });
		setHighlightId(focusedMessageId);
		// The anchor jump IS this thread's initial scroll — claim the ref so the
		// bottom-scroll effect doesn't clobber it once the param strips below.
		initialScrollThread.current = focusedThreadId;
		void stripAnchor();
	}, [focusedMessageId, focusedThreadId, messages, hydration, navigate]);

	// Fade the lamplight ring after it has held long enough to be seen. Separate
	// from the anchor-consume above so consuming the one-shot anchor never cancels
	// this hold timer. The ring's bloom/fade is CSS (motion-safe); reduced-motion
	// shows a static ring for the same dwell, then this clears it.
	useEffect(() => {
		if (highlightId === null) return;
		const t = setTimeout(() => setHighlightId(null), 1600);
		return () => clearTimeout(t);
	}, [highlightId]);

	// Re-run a failed hydration on demand (issue #108): `hydrateThread` flips status back to `loading`, then `ready`/`error` on settle.
	const retryHydration = () => {
		if (focusedThreadId === null) return;
		void hydrateThread(runtime, focusedThreadId);
	};

	// Re-issue a previous user turn after a failed/interrupted Run; always the `send` path since the thread already exists.
	const retry = (text: string) => {
		if (focusedThreadId === null) return;
		setSendError(null);
		void send(runtime, focusedThreadId, text).then(async (result) => {
			if (!result.ok) {
				setSendError("Couldn't send your message. Please try again.");
			}
			// Refresh both reads this surface shows: the sidebar's thread list and
			// the right-rail recent-Runs feed (the retried send births/advances a Run).
			await queryClient.invalidateQueries({ queryKey: ["threads"] });
			await queryClient.invalidateQueries({ queryKey: ["run-history"] });
		});
	};

	return (
		<main className="flex h-full flex-col overflow-hidden bg-chat-bg">
			<div ref={scrollerRef} className="flex-1 overflow-y-auto px-6 pt-14 pb-6">
				{showWelcome ? (
					<ChatWelcome />
				) : threadNotFound ? (
					<ChatThreadNotFound onNewChat={() => navigate({ to: "/" })} />
				) : hydrationFailed ? (
					<ChatHydrationError onRetry={retryHydration} />
				) : showHydrating ? (
					<ChatHydrating />
				) : (
					<ol className="mx-auto flex max-w-3xl flex-col gap-6">
						{messages.map((message, i) =>
							message.role === "user" ? (
								<UserBubble
									key={message.id}
									message={message}
									highlighted={message.id === highlightId}
								/>
							) : (
								<AssistantBubble
									key={message.id}
									message={message}
									highlighted={message.id === highlightId}
									onRetry={
										focusedThreadId !== null && messages[i - 1]?.role === "user"
											? () => retry(concatText(messages[i - 1].segments))
											: undefined
									}
								/>
							),
						)}
					</ol>
				)}
			</div>
			{sendError !== null && (
				<p
					role="alert"
					className="mx-auto max-w-3xl px-6 text-sm text-destructive"
				>
					{sendError}
				</p>
			)}
			<ComposeFooter
				isRunning={activeRunId !== null}
				onStop={() => {
					if (activeRunId !== null) void cancelRun(runtime, activeRunId);
				}}
				onSend={async (text) => {
					// Send into the focused thread, or mint a new one; then refresh the
					// reads this surface shows: the sidebar's thread/list and the
					// right-rail recent-Runs feed (a send births/advances a Run).
					setSendError(null);
					if (focusedThreadId !== null) {
						const result = await send(runtime, focusedThreadId, text);
						if (!result.ok) {
							setSendError("Couldn't send your message. Please try again.");
						}
					} else {
						// Mint-on-send: thread focus is the URL (ADR-0042), so on success
						// navigate to the new thread's route. The thread is pre-seeded and
						// marked `ready`, so the post-navigate remount reads it without a
						// re-hydrate; on failure stay on `/` and surface the error.
						const result = await sendNewThread(runtime, text);
						if (result.ok) {
							void navigate({
								to: "/thread/$threadId",
								params: { threadId: result.threadId },
							});
						} else {
							setSendError("Couldn't send your message. Please try again.");
						}
					}
					await queryClient.invalidateQueries({ queryKey: ["threads"] });
					await queryClient.invalidateQueries({ queryKey: ["run-history"] });
				}}
			/>
		</main>
	);
}

/** First-run / fresh-chat welcome: teaches the chat → Proposal → Library loop. */
function ChatWelcome() {
	return (
		<div className="mx-auto flex min-h-full max-w-3xl flex-col items-center justify-center motion-safe:animate-rise">
			<EmptyState
				icon={Sparkles}
				tone="brand"
				size="lg"
				title="Start a chat"
				description="Type below to begin. Inkstone drafts journal entries and the structured items it notices, and they land in your Library once you approve them."
			/>
		</div>
	);
}

/** Shown when a focused thread's hydration fails (issue #108): a recoverable error, never an eternal skeleton. */
function ChatHydrationError({ onRetry }: { onRetry: () => void }) {
	return (
		<div
			role="alert"
			className="mx-auto flex min-h-full max-w-3xl flex-col items-center justify-center"
		>
			<EmptyState
				icon={TriangleAlert}
				tone="danger"
				size="lg"
				title="Couldn't load this conversation"
				description="Something went wrong fetching these messages. Your data is safe on disk — try again."
				action={
					<Button variant="chip" size="pill" onClick={onRetry}>
						<RotateCcw className="size-3.5" aria-hidden />
						Try again
					</Button>
				}
			/>
		</div>
	);
}

/** Shown while a selected thread hydrates: placeholder bubbles, not a spinner. */
/** A Thread the URL points at that Core says doesn't exist (ADR-0042): an honest
 *  dead-end with a Back-to-New-Chat exit — mirrors the Library's "Unknown
 *  collection" card. NOT a retry: a missing Thread can't be re-fetched into being. */
function ChatThreadNotFound({ onNewChat }: { onNewChat: () => void }) {
	return (
		<div className="mx-auto flex min-h-full max-w-3xl flex-col items-center justify-center">
			<EmptyState
				icon={MessageSquareDashed}
				size="lg"
				title="This thread isn't available"
				description="It may have been deleted, or the link points to a thread that no longer exists."
				action={
					<Button variant="chip" size="pill" onClick={onNewChat}>
						Back to New Chat
					</Button>
				}
			/>
		</div>
	);
}
function ChatHydrating() {
	return (
		<div
			role="status"
			aria-label="Loading conversation"
			className="mx-auto flex max-w-3xl flex-col gap-6"
		>
			<div className="flex justify-end">
				<div className="h-12 w-2/5 animate-pulse rounded-xl bg-secondary/60" />
			</div>
			<div className="flex flex-col gap-2">
				<div className="h-4 w-3/4 animate-pulse rounded bg-secondary/50" />
				<div className="h-4 w-5/6 animate-pulse rounded bg-secondary/50" />
				<div className="h-4 w-1/2 animate-pulse rounded bg-secondary/50" />
			</div>
		</div>
	);
}

function UserBubble({
	message,
	highlighted = false,
}: {
	message: Message;
	highlighted?: boolean;
}) {
	return (
		<li
			data-role="user"
			data-message-id={message.id}
			className="flex flex-col items-end gap-1"
		>
			<div
				data-highlighted={highlighted || undefined}
				className="search-jump-target relative max-w-[80%] rounded-xl border border-secondary/50 bg-secondary/50 px-4 py-2 text-sm text-foreground"
			>
				{concatText(message.segments)}
			</div>
		</li>
	);
}

/** A maximal run of consecutive `tool_call` segments collapsed for one
 * {@link ToolActivity} (so grouping/`+N` overflow is preserved), or a single
 * `text`/`proposal` segment — the unit the bubble renders in timeline order (ADR-0045). */
type RenderGroup =
	| { readonly kind: "tools"; readonly calls: ToolCall[] }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "proposal"; readonly runId: string };

/** Fold the ordered timeline into render groups: consecutive `tool_call` segments
 * coalesce into ONE group (existing grouping + tests stay intact); text/proposal
 * segments render between such runs, preserving event-arrival order. */
function toRenderGroups(segments: readonly Segment[]): RenderGroup[] {
	const groups: RenderGroup[] = [];
	for (const seg of segments) {
		if (seg.kind === "tool_call") {
			const last = groups[groups.length - 1];
			if (last?.kind === "tools") {
				last.calls.push(seg.call);
			} else {
				groups.push({ kind: "tools", calls: [seg.call] });
			}
		} else if (seg.kind === "text") {
			groups.push({ kind: "text", text: seg.text });
		} else {
			groups.push({ kind: "proposal", runId: seg.runId });
		}
	}
	return groups;
}

function AssistantBubble({
	message,
	highlighted = false,
	onRetry,
}: {
	message: Message;
	highlighted?: boolean;
	onRetry?: () => void;
}) {
	// `segments` is the SOLE render source (ADR-0045); the flat reply text the copy
	// button / typing-indicator read derives through `concatText` — one source of truth.
	const text = concatText(message.segments);
	const toolRunning = message.segments.some(
		(seg) => seg.kind === "tool_call" && seg.call.status === "running",
	);
	const groups = toRenderGroups(message.segments);
	return (
		<li
			data-role="assistant"
			data-message-id={message.id}
			className="group flex flex-col items-start gap-2"
		>
			{/* Render the turn's pieces in event-arrival order (ADR-0045): tool rows,
			    the Proposal, and text interleave by their timeline position, not a
			    fixed JSX child order. The decided "Applied." pill therefore sits where
			    the Proposal happened — above a reply that followed it. */}
			{groups.map((group, i) =>
				group.kind === "tools" ? (
					<ToolActivity
						// biome-ignore lint/suspicious/noArrayIndexKey: timeline position is the identity here
						key={`tools-${i}`}
						toolCalls={group.calls}
					/>
				) : group.kind === "proposal" ? (
					<AssistantProposals
						// biome-ignore lint/suspicious/noArrayIndexKey: timeline position is the identity here
						key={`proposal-${i}`}
						runId={group.runId}
					/>
				) : (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: timeline position is the identity here
						key={`text-${i}`}
						data-highlighted={highlighted || undefined}
						className="search-jump-target prose prose-pink dark:prose-invert relative max-w-none rounded-xl"
					>
						<ChatMarkdown text={group.text} />
					</div>
				),
			)}
			{message.status === "streaming" && text === "" && !toolRunning && (
				<div
					data-testid="typing-indicator"
					role="status"
					aria-label="Assistant is typing"
					className="flex items-center gap-1 px-1 py-2"
				>
					<span className="size-2 rounded-full bg-muted-foreground motion-safe:[animation:typing-pulse_1.2s_ease-in-out_infinite]" />
					<span className="size-2 rounded-full bg-muted-foreground motion-safe:[animation:typing-pulse_1.2s_ease-in-out_infinite] motion-safe:[animation-delay:0.2s]" />
					<span className="size-2 rounded-full bg-muted-foreground motion-safe:[animation:typing-pulse_1.2s_ease-in-out_infinite] motion-safe:[animation-delay:0.4s]" />
				</div>
			)}
			{message.status === "completed" && text.length > 0 && (
				<div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
					<CopyButton text={text} />
				</div>
			)}
			{message.status === "incomplete" && (
				<div
					role="alert"
					tabIndex={-1}
					data-testid="assistant-error"
					className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm outline-none"
				>
					<span>
						{message.error ??
							"This reply stopped before it finished. Nothing was saved without your approval."}
					</span>
					{onRetry && (
						<button
							type="button"
							onClick={onRetry}
							className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-destructive/40 px-2 py-1 font-medium text-xs transition-colors hover:bg-destructive/20 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive"
						>
							<RotateCcw className="size-3.5" aria-hidden />
							Try again
						</button>
					)}
				</div>
			)}
		</li>
	);
}
