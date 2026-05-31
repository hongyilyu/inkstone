import { useProposalById } from "@/lib/hooks/useProposalById";
import { ProposalCard } from "./ProposalCard.js";

export function AgentProposals({ proposalIds }: { proposalIds: string[] }) {
	return (
		<div className="mt-1 flex w-full flex-col gap-3">
			{proposalIds.map((id) => (
				<ProposalRef key={id} id={id} />
			))}
		</div>
	);
}

function ProposalRef({ id }: { id: string }) {
	const proposal = useProposalById(id);
	return proposal ? <ProposalCard proposal={proposal} /> : null;
}
