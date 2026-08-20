// Shared fixtures for the TickTick write-family tests (store + component).

import type { ThreadGetResult, TickTickWriteState } from "@inkstone/protocol";

/** A thread/get body whose run-1 proposal segment carries `write` — the
 * durable truth the bounded observe-poll reads. */
export function threadWithWriteSegment(
	write: Exclude<TickTickWriteState, { state: "proposed" }>,
): ThreadGetResult {
	return {
		thread_id: "thread-1",
		title: "t",
		messages: [
			{
				id: "m1",
				role: "assistant",
				status: "completed",
				run_id: "run-1",
				segments: [
					{
						kind: "proposal",
						proposal_id: "prop-tt-1",
						mutation_kind: "create_ticktick_task",
						status: "accepted",
						ticktick_write: write,
					},
				],
			},
		],
	};
}
