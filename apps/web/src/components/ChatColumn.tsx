import { useLayoutEffect, useRef } from "react";
import { useRuntime } from "@/runtime";
import { send, sendNewThread } from "@/store/bridge";
import {
	type Message,
	useFocusedThreadId,
	useThreadMessages,
} from "@/store/chat";
import { useHydrateFocusedThread } from "@/store/hydrate";
import { ComposeFooter } from "./ComposeFooter.js";

export function ChatColumn() {
	const scrollerRef = useRef<HTMLDivElement>(null);
	const runtime = useRuntime();
	const focusedThreadId = useFocusedThreadId();
	const messages = useThreadMessages(focusedThreadId ?? "");

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
			<ComposeFooter
				onSend={(text) => {
					if (focusedThreadId !== null) {
						void send(runtime, focusedThreadId, text);
					} else {
						void sendNewThread(runtime, text);
					}
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
		<li data-role="assistant" className="flex flex-col items-start gap-2">
			<div className="prose prose-pink dark:prose-invert max-w-none">
				{message.text}
			</div>
		</li>
	);
}
