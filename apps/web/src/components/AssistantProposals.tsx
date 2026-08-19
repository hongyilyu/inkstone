import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { invalidateEntityReads } from "@/lib/entityReads";
import { TASKS_KEY_PREFIX } from "@/lib/hooks/useTickTick";
import { useRuntime } from "@/runtime";
import { decideProposal } from "@/store/bridge";
import { getChatState, useProposalForRun } from "@/store/chat";
import { ProposalCard } from "./ProposalCard.js";

/** Renders the live pending Proposal (if any) for an assistant turn's Run, keyed by `runId`; deciding routes through {@link decideProposal}. See docs/design/web-chat-ui.md. */
export function AssistantProposals({ runId }: { runId: string }) {
	const runtime = useRuntime();
	const queryClient = useQueryClient();
	const proposal = useProposalForRun(runId);
	// A CREATED TickTick write (and only `created` — a failed/unknown write
	// changed nothing worth refetching) invalidates the Tasks read, so the
	// next Tasks render refetches under the current connection (ticktick-writes
	// W-A5). An EFFECT on the record's state transition, not a decide callback:
	// the created outcome can also arrive via the bounded observe-poll or the
	// settle notification (a replay that answered "executing" first), which no
	// callback sees. Once per created TRANSITION — the ref resets when the
	// state leaves `created`, so a re-parked run's SECOND write invalidates
	// again; invalidation is idempotent, so a remount over an already-created
	// record merely refetches fresh data.
	const invalidatedCreated = useRef(false);
	const writeState = proposal?.ticktick_write?.state;
	useEffect(() => {
		if (writeState === "created") {
			if (!invalidatedCreated.current) {
				invalidatedCreated.current = true;
				void queryClient.invalidateQueries({ queryKey: TASKS_KEY_PREFIX });
			}
			return;
		}
		invalidatedCreated.current = false;
	}, [writeState, queryClient]);
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
					// An accepted decision created an Entity → refresh both entity reads
					// (the Library list and any open Inspector's backlinks, ADR-0050)
					// through the one owner of that policy. Gate on the SETTLED store
					// status, not the requested decision: a raced reject can settle as
					// accepted from durable truth (the -32002 settlement path), and a
					// rejected settlement creates nothing. A cleared entry (a concurrent
					// cancelRun raced a decide that may have committed at Core) falls
					// back to the requested decision — over-invalidating beats a stale
					// Library.
					const settled = getChatState().proposals[runId];
					if (
						settled === undefined
							? decision !== "reject"
							: settled.status === "accepted"
					) {
						await invalidateEntityReads(queryClient);
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
