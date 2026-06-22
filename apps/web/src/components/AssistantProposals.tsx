import { useQueryClient } from "@tanstack/react-query";
import { useRuntime } from "@/runtime";
import { decideProposal } from "@/store/bridge";
import { useProposalForRun } from "@/store/chat";
import { ProposalCard } from "./ProposalCard.js";

/** Renders the live pending Proposal (if any) for an assistant turn's Run, keyed by `runId`; deciding routes through {@link decideProposal}. See docs/design/web-chat-ui.md. */
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
				onDecide={async (decision, editedPayload, decisions) => {
					await decideProposal(
						runtime,
						runId,
						decision,
						editedPayload,
						decisions,
					);
					// accept/edit creates an Entity → refresh the Library; reject creates nothing.
					if (decision !== "reject") {
						await queryClient.invalidateQueries({
							queryKey: ["library-items"],
						});
					}
					// Every decision advances the parked Run (it resumes and runs to a
					// new milestone), so the recent-Runs feed is now stale regardless of
					// accept/reject/edit — refresh it so a "Waiting" row doesn't linger.
					await queryClient.invalidateQueries({ queryKey: ["run-history"] });
				}}
			/>
		</div>
	);
}
