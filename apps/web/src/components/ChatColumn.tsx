import { CheckCircle2, Edit3, Eye, Search } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { type ChatTurn, conversation, proposals } from "../data/mock.js";
import { ComposeFooter } from "./ComposeFooter.js";
import { ProposalCard } from "./ProposalCard.js";
import { QueueBanner } from "./QueueBanner.js";

const proposalById = new Map(proposals.map((p) => [p.id, p]));

const ICON = {
	read: Eye,
	search: Search,
	write: Edit3,
	decide: CheckCircle2,
} as const;

export function ChatColumn() {
	const scrollerRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const el = scrollerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, []);

	return (
		<main className="flex h-full flex-col overflow-hidden bg-chat-bg">
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
			<div className="max-w-[80%] rounded-xl border border-secondary/50 bg-secondary/50 px-4 py-2 text-sm text-foreground">
				{turn.text}
			</div>
			<span className="text-xs text-foreground/40">{turn.t}</span>
		</li>
	);
}

function AgentBubble({ turn }: { turn: Extract<ChatTurn, { role: "agent" }> }) {
	return (
		<li
			data-role="agent"
			className="flex flex-col items-start gap-2"
		>
			<div className="prose prose-pink dark:prose-invert max-w-none">
				{turn.text}
			</div>
			{turn.actions ? (
				<div className="flex flex-wrap gap-1">
					{turn.actions.map((a, i) => {
						const I = ICON[a.kind];
						return (
							<button
								key={i}
								type="button"
								data-action={a.kind}
								className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
							>
								<I
									className="h-3 w-3"
									aria-hidden
								/>
								<span>{a.label}</span>
							</button>
						);
					})}
				</div>
			) : null}
			{turn.proposalIds ? (
				<div className="mt-1 flex w-full flex-col gap-3">
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
			<span className="text-xs text-foreground/40">{turn.t}</span>
		</li>
	);
}
