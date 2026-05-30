import { useLayoutEffect, useRef } from "react";
import type { ChatTurn } from "@/data/mock/types";
import { useConversation } from "@/lib/hooks/useConversation";
import { AgentActions } from "./AgentActions.js";
import { AgentProposals } from "./AgentProposals.js";
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
			<div ref={scrollerRef} className="flex-1 overflow-y-auto px-6 py-6">
				<ol className="mx-auto flex max-w-3xl flex-col gap-6">
					{conversation?.map((turn, i) =>
						turn.role === "user" ? (
							<UserBubble key={i} turn={turn} />
						) : (
							<AgentBubble key={i} turn={turn} />
						),
					)}
				</ol>
			</div>
			<ComposeFooter onSend={(text) => console.log("send:", text)} />
		</main>
	);
}

function UserBubble({ turn }: { turn: Extract<ChatTurn, { role: "user" }> }) {
	return (
		<li data-role="user" className="flex flex-col items-end gap-1">
			<div className="max-w-[80%] rounded-xl border border-secondary/50 bg-secondary/50 px-4 py-2 text-sm text-foreground">
				{turn.text}
			</div>
			<span className="text-xs text-foreground/40">{turn.t}</span>
		</li>
	);
}

function AgentBubble({ turn }: { turn: Extract<ChatTurn, { role: "agent" }> }) {
	return (
		<li data-role="agent" className="flex flex-col items-start gap-2">
			<div className="prose prose-pink dark:prose-invert max-w-none">
				{turn.text}
			</div>
			{turn.actions ? <AgentActions actions={turn.actions} /> : null}
			{turn.proposalIds ? (
				<AgentProposals proposalIds={turn.proposalIds} />
			) : null}
			<span className="text-xs text-foreground/40">{turn.t}</span>
		</li>
	);
}
