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
			className="rounded-lg border border-border bg-card p-3 text-card-foreground"
		>
			<header className="flex items-center gap-2 text-sm">
				<Icon
					className="h-4 w-4 text-muted-foreground"
					aria-hidden
				/>
				<span className="font-medium">{proposal.title}</span>
				<span className="ml-auto text-xs text-muted-foreground">{proposal.target}</span>
			</header>
			<p className="mt-1.5 text-xs text-muted-foreground">{proposal.summary}</p>
			<pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-xs text-foreground">
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
