import { useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRuntime } from "@/runtime";
import {
	cancelRun,
	send,
	sendNewThread,
	startProposalStream,
} from "@/store/bridge";
import {
	type Message,
	useActiveRunId,
	useFocusedThreadId,
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
	const focusedThreadId = useFocusedThreadId();
	const messages = useThreadMessages(focusedThreadId ?? "");
	// Set while a Run streams AND while it's parked awaiting a Proposal (only a
	// terminal Run Event clears it) — so Stop covers both, matching run/cancel.
	const activeRunId = useActiveRunId(focusedThreadId ?? "");
	const hydration = useHydrationStatus(focusedThreadId ?? "");
	const [sendError, setSendError] = useState<string | null>(null);

	// No thread focused → fresh chat. Focused + empty: the reactive hydration status (issue #108) decides —
	// skeleton only while the fetch is genuinely in flight (or about to fire), a recoverable error if it failed
	// (never an eternal skeleton), and the message list otherwise (PRODUCT.md "show the state, not a spinner").
	const noMessages = messages.length === 0;
	const showWelcome = focusedThreadId === null && noMessages;
	const hydrationFailed =
		focusedThreadId !== null && noMessages && hydration === "error";
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

	useLayoutEffect(() => {
		const el = scrollerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, []);

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
			await queryClient.invalidateQueries({ queryKey: ["threads"] });
		});
	};

	return (
		<main className="flex h-full flex-col overflow-hidden bg-chat-bg">
			<div ref={scrollerRef} className="flex-1 overflow-y-auto px-6 pt-14 pb-6">
				{showWelcome ? (
					<ChatWelcome />
				) : hydrationFailed ? (
					<ChatHydrationError onRetry={retryHydration} />
				) : showHydrating ? (
					<ChatHydrating />
				) : (
					<ol className="mx-auto flex max-w-3xl flex-col gap-6">
						{messages.map((message, i) =>
							message.role === "user" ? (
								<UserBubble key={message.id} message={message} />
							) : (
								<AssistantBubble
									key={message.id}
									message={message}
									onRetry={
										focusedThreadId !== null && messages[i - 1]?.role === "user"
											? () => retry(messages[i - 1].text)
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
					// Send into the focused thread, or mint a new one; then refresh the sidebar's thread/list read.
					setSendError(null);
					const result =
						focusedThreadId !== null
							? await send(runtime, focusedThreadId, text)
							: await sendNewThread(runtime, text);
					if (!result.ok) {
						setSendError("Couldn't send your message. Please try again.");
					}
					await queryClient.invalidateQueries({ queryKey: ["threads"] });
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

function UserBubble({ message }: { message: Message }) {
	return (
		<li data-role="user" className="flex flex-col items-end gap-1">
			<div className="max-w-[80%] rounded-xl border border-secondary/50 bg-secondary/50 px-4 py-2 text-sm text-foreground">
				{message.text}
			</div>
		</li>
	);
}

function AssistantBubble({
	message,
	onRetry,
}: {
	message: Message;
	onRetry?: () => void;
}) {
	const toolCalls = message.toolCalls ?? [];
	const toolRunning = toolCalls.some((tc) => tc.status === "running");
	return (
		<li data-role="assistant" className="group flex flex-col items-start gap-2">
			{toolCalls.length > 0 && <ToolActivity toolCalls={toolCalls} />}
			{message.status === "streaming" &&
				message.text === "" &&
				!toolRunning && (
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
			{message.text.length > 0 && (
				<div className="prose prose-pink dark:prose-invert max-w-none">
					<ChatMarkdown text={message.text} />
				</div>
			)}
			{message.status === "completed" && message.text.length > 0 && (
				<div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
					<CopyButton text={message.text} />
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
			{message.run_id !== "" && <AssistantProposals runId={message.run_id} />}
		</li>
	);
}
