import { useQueryClient } from "@tanstack/react-query";
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
 *
 * On an accept/edit (which creates an Entity in Core) we invalidate the
 * `["library-items"]` query so the Library reflects the new Journal Entry without a
 * manual reload. A reject creates nothing, so it is not invalidated.
 */
export function AssistantProposals({ runId }: { runId: string }) {
	const runtime = useRuntime();
	const queryClient = useQueryClient();
	const proposal = useProposalForRun(runId);
	if (proposal === null) {
		return null;
	}
	return (
		<div className="mt-1 flex w-full flex-col gap-3">
			<ProposalCard
				proposal={proposal}
				onDecide={async (decision, editedPayload) => {
					await decideProposal(runtime, runId, decision, editedPayload);
					if (decision !== "reject") {
						await queryClient.invalidateQueries({
							queryKey: ["library-items"],
						});
					}
				}}
			/>
		</div>
	);
}
