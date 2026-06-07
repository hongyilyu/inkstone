import { useRuntime } from "@/runtime";
import { decideProposal } from "@/store/bridge";
import { useProposalForRun } from "@/store/chat";
import { ProposalCard } from "./ProposalCard.js";

/**
 * Render the live pending Proposal (if any) for an assistant turn's Run. The
 * Proposal is keyed by `runId` in the chat store (a parked Run pushes a
 * `proposal/pending` notification → the bridge attaches it). Deciding routes
 * through {@link decideProposal}, which calls `proposal/decide` and resumes the
 * Run. Renders nothing until a Proposal is attached.
 */
export function AssistantProposals({ runId }: { runId: string }) {
	const runtime = useRuntime();
	const proposal = useProposalForRun(runId);
	if (proposal === null) {
		return null;
	}
	return (
		<div className="mt-1 flex w-full flex-col gap-3">
			<ProposalCard
				proposal={proposal}
				onDecide={(decision, editedPayload) =>
					decideProposal(runtime, runId, decision, editedPayload)
				}
			/>
		</div>
	);
}
