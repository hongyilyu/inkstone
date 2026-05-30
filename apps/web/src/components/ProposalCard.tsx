// VISUAL ONLY — auto-applied + undo affordance shown here is reference; real wiring will manual-approve all proposals per ADR-0016.
import { Check, File, FileText, Folder } from "lucide-react";
import type { ElementType } from "react";
import type { Proposal, ProposalKind } from "../data/mock.js";

const KIND_ICON = {
	todo: Check,
	project: Folder,
	note: FileText,
	file: File,
} as const satisfies Record<ProposalKind, ElementType>;

export function ProposalCard({ proposal }: { proposal: Proposal }) {
	const Icon = KIND_ICON[proposal.kind];
	return (
		<article
			data-proposal-kind={proposal.kind}
			className="rounded-lg border border-border bg-card p-5 text-card-foreground"
		>
			<header className="flex items-center gap-2 text-sm">
				<Icon
					className="h-4 w-4 text-card-foreground/60"
					aria-hidden
				/>
				<span className="font-medium">{proposal.title}</span>
				<span className="ml-auto text-xs text-card-foreground/60">{proposal.target}</span>
			</header>
			<p className="mt-2 text-sm leading-relaxed text-card-foreground/80">{proposal.summary}</p>
			<pre className="mt-3 whitespace-pre-wrap rounded-md bg-secondary/50 p-3 font-mono text-xs leading-relaxed text-foreground">
				{proposal.diff.map((line, i) => (
					<div key={i}>
						{line.before ? <div className="text-destructive">- {line.before}</div> : null}
						<div>{line.after}</div>
					</div>
				))}
			</pre>
		</article>
	);
}
