import { useLayoutEffect, useRef } from "react";
import { type ChatTurn, conversation, proposals } from "../data/mock.js";
import { ComposeFooter } from "./ComposeFooter.js";
import { ProposalCard } from "./ProposalCard.js";
import { QueueBanner } from "./QueueBanner.js";

const proposalById = new Map(proposals.map((p) => [p.id, p]));

export function ChatColumn() {
	const scrollerRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const el = scrollerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, []);

	return (
		<main className="flex h-full flex-col overflow-hidden">
			<QueueBanner />
			<div
				ref={scrollerRef}
				className="flex-1 overflow-y-auto px-6 py-6"
			>
				<ol className="mx-auto flex max-w-3xl flex-col gap-6">
					{conversation.map((turn, i) =>
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
		<li
			data-role="user"
			className="flex flex-col items-end gap-1"
		>
			<div className="rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground">
				{turn.text}
			</div>
			<span className="text-xs text-muted-foreground">{turn.t}</span>
		</li>
	);
}

function AgentBubble({ turn }: { turn: Extract<ChatTurn, { role: "agent" }> }) {
	return (
		<li
			data-role="agent"
			className="flex flex-col items-start gap-2"
		>
			<div className="rounded-2xl bg-card px-4 py-2 text-sm text-card-foreground">
				{turn.text}
			</div>
			{turn.actions ? (
				<div className="flex flex-wrap gap-1.5">
					{turn.actions.map((a, i) => (
						<span
							key={i}
							data-action={a.kind}
							className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
						>
							{a.label}
						</span>
					))}
				</div>
			) : null}
			{turn.proposalIds ? (
				<div className="flex w-full flex-col gap-2">
					{turn.proposalIds.map((id) => {
						const p = proposalById.get(id);
						return p ? (
							<ProposalCard
								key={id}
								proposal={p}
							/>
						) : null;
					})}
				</div>
			) : null}
			<span className="text-xs text-muted-foreground">{turn.t}</span>
		</li>
	);
}
