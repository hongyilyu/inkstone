import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { useRuntime } from "@/runtime";
import { send, sendNewThread } from "@/store/bridge";
import {
	type Message,
	useFocusedThreadId,
	useThreadMessages,
} from "@/store/chat";
import { useHydrateFocusedThread } from "@/store/hydrate";
import { ChatMarkdown } from "./ChatMarkdown.js";
import { ComposeFooter } from "./ComposeFooter.js";
import { CopyButton } from "./CopyButton.js";

export function ChatColumn() {
	const scrollerRef = useRef<HTMLDivElement>(null);
	const runtime = useRuntime();
	const queryClient = useQueryClient();
	const focusedThreadId = useFocusedThreadId();
	const messages = useThreadMessages(focusedThreadId ?? "");
	const [sendError, setSendError] = useState<string | null>(null);

	// On focus change to a non-null, not-yet-live thread: thread/get → load →
	// resubscribe-if-streaming. Locally-originated threads are pre-marked so this
	// is a no-op for them (no double-load / double-resubscribe).
	useHydrateFocusedThread(runtime, focusedThreadId);

	useLayoutEffect(() => {
		const el = scrollerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, []);

	return (
		<main className="flex h-full flex-col overflow-hidden bg-chat-bg">
			<div ref={scrollerRef} className="flex-1 overflow-y-auto px-6 pt-14 pb-6">
				<ol className="mx-auto flex max-w-3xl flex-col gap-6">
					{messages.map((message) =>
						message.role === "user" ? (
							<UserBubble key={message.id} message={message} />
						) : (
							<AssistantBubble key={message.id} message={message} />
						),
					)}
				</ol>
			</div>
			{sendError !== null && (
				<p role="alert" className="mx-auto max-w-3xl px-6 text-sm text-destructive">
					{sendError}
				</p>
			)}
			<ComposeFooter
				onSend={async (text) => {
					// Send into the focused thread, or mint a new one on the first
					// message. Either way, refresh the sidebar's thread/list read so
					// a freshly-created thread (or a bumped last-activity order) shows
					// without a manual reload — the precondition for switching threads.
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

function UserBubble({ message }: { message: Message }) {
	return (
		<li data-role="user" className="flex flex-col items-end gap-1">
			<div className="max-w-[80%] rounded-xl border border-secondary/50 bg-secondary/50 px-4 py-2 text-sm text-foreground">
				{message.text}
			</div>
		</li>
	);
}

function AssistantBubble({ message }: { message: Message }) {
	return (
		<li data-role="assistant" className="group flex flex-col items-start gap-2">
			{message.status === "streaming" && message.text === "" && (
				<div
					data-testid="typing-indicator"
					aria-label="Assistant is typing"
					className="flex items-center gap-1 px-1 py-2"
				>
					<span className="size-2 rounded-full bg-muted-foreground [animation:typing-pulse_1.2s_ease-in-out_infinite]" />
					<span className="size-2 rounded-full bg-muted-foreground [animation:typing-pulse_1.2s_ease-in-out_infinite] [animation-delay:0.2s]" />
					<span className="size-2 rounded-full bg-muted-foreground [animation:typing-pulse_1.2s_ease-in-out_infinite] [animation-delay:0.4s]" />
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
					data-testid="assistant-error"
					className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm"
				>
					{message.error ?? "This response didn't finish."}
				</div>
			)}
		</li>
	);
}
