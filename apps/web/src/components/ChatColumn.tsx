import { useLayoutEffect, useRef } from "react";
import type { MockChatMessage } from "@/data/mock/types";
import { useConversation } from "@/lib/hooks/useConversation";
import { AssistantActions } from "./AssistantActions.js";
import { AssistantProposals } from "./AssistantProposals.js";
import { ComposeFooter } from "./ComposeFooter.js";

export function ChatColumn() {
	const scrollerRef = useRef<HTMLDivElement>(null);
	const { data: conversation } = useConversation();

	useLayoutEffect(() => {
		const el = scrollerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, []);

	return (
		<main className="flex h-full flex-col overflow-hidden bg-chat-bg">
			<div ref={scrollerRef} className="flex-1 overflow-y-auto px-6 pt-14 pb-6">
				<ol className="mx-auto flex max-w-3xl flex-col gap-6">
					{conversation?.map((message, i) =>
						message.role === "user" ? (
							<UserBubble key={i} message={message} />
						) : (
							<AssistantBubble key={i} message={message} />
						),
					)}
				</ol>
			</div>
			<ComposeFooter onSend={(text) => console.log("send:", text)} />
		</main>
	);
}

function UserBubble({
	message,
}: {
	message: Extract<MockChatMessage, { role: "user" }>;
}) {
	return (
		<li data-role="user" className="flex flex-col items-end gap-1">
			<div className="max-w-[80%] rounded-xl border border-secondary/50 bg-secondary/50 px-4 py-2 text-sm text-foreground">
				{message.text}
			</div>
			<span className="text-xs text-foreground/40">{message.t}</span>
		</li>
	);
}

function AssistantBubble({
	message,
}: {
	message: Extract<MockChatMessage, { role: "assistant" }>;
}) {
	return (
		<li data-role="assistant" className="flex flex-col items-start gap-2">
			<div className="prose prose-pink dark:prose-invert max-w-none">
				{message.text}
			</div>
			{message.actions ? <AssistantActions actions={message.actions} /> : null}
			{message.proposalIds ? (
				<AssistantProposals proposalIds={message.proposalIds} />
			) : null}
			<span className="text-xs text-foreground/40">{message.t}</span>
		</li>
	);
}
