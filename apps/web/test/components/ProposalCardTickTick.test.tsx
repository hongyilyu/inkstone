// The TickTick write-family card (ticktick-writes W3): every card state —
// pending, stale-connection (accept + edit disabled, reject enabled),
// deciding, executing (with the bounded poll driving hydrated cards to the
// recorded outcome), created (+ the at-cap caveat), failed, unknown, the
// past-deadline "still unresolved" + Resolve now, and rejected. States differ
// by glyph + label (`data-ticktick-write`), never color alone.
//
// The existing ProposalCard suite is untouched (ticktick-writes W3 verify).

import type { WsClientService } from "@inkstone/ui-sdk";
import { renderWithRouterContext } from "@test/test-utils/renderWithCore";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantProposals } from "@/components/AssistantProposals";
import { ProposalCard } from "@/components/ProposalCard";
import { TASKS_KEY_PREFIX } from "@/lib/hooks/useTickTick";
import { resetBridge } from "@/store/bridge";
import {
	appendMessage,
	attachRun,
	beginRunSubscription,
	nextMessageId,
	type PendingProposal,
	rehydrateDecidedProposal,
	resetChatStore,
	setPendingProposal,
} from "@/store/chat";
import { threadWithWriteSegment } from "../store/ticktickWrite.test-support.js";

const base: PendingProposal = {
	proposal_id: "prop-tt-1",
	run_id: "run-1",
	mutation_kind: "create_ticktick_task",
	payload: {
		title: "buy milk",
		note: "2%",
		due: {
			date: "2026-09-02T00:30:00.000+0000",
			is_all_day: false,
			time_zone: "America/Los_Angeles",
		},
	},
	rationale: "the user asked for a reminder",
	status: "pending",
};

beforeEach(() => {
	resetChatStore();
	resetBridge();
});

afterEach(() => {
	cleanup();
});

/** Seed the store with an assistant turn bound to run-1 (the poll and the
 * decide resume path both resolve the thread through the run record). */
function seedRunTurn(): void {
	const assistantId = nextMessageId();
	appendMessage("thread-1", {
		id: assistantId,
		role: "assistant",
		status: "streaming",
		segments: [],
		run_id: "",
	});
	attachRun("thread-1", assistantId, "run-1");
	beginRunSubscription("thread-1", "run-1");
}

describe("pending card", () => {
	it("renders the task review copy, due, note, and the → Inbox affordance", () => {
		renderWithRouterContext(
			<ProposalCard proposal={base} onDecide={() => {}} />,
		);
		expect(
			screen.getByText("Inkstone wants to create a task in TickTick."),
		).toBeInTheDocument();
		expect(screen.getByText("buy milk")).toBeInTheDocument();
		expect(screen.getByText("2%")).toBeInTheDocument();
		expect(screen.getByText("→ Inbox")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /create in ticktick/i }),
		).toBeEnabled();
		expect(screen.getByRole("button", { name: /dismiss/i })).toBeEnabled();
		expect(screen.getByRole("button", { name: /edit/i })).toBeEnabled();
	});

	it("accept/reject call onDecide; deciding shows the busy label", () => {
		const onDecide = vi.fn();
		const { rerender } = renderWithRouterContext(
			<ProposalCard proposal={base} onDecide={onDecide} />,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /create in ticktick/i }),
		);
		expect(onDecide).toHaveBeenCalledWith("accept");
		rerender(
			<ProposalCard
				proposal={{ ...base, status: "deciding" }}
				onDecide={onDecide}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /creating in ticktick/i }),
		).toBeDisabled();
	});
});

describe("the stale-connection card (derived, survives reload)", () => {
	const stale: PendingProposal = {
		...base,
		ticktick_write: { state: "proposed", stale_connection: true },
	};

	it("warns with accept AND edit disabled while reject stays enabled", () => {
		const onDecide = vi.fn();
		renderWithRouterContext(
			<ProposalCard proposal={stale} onDecide={onDecide} />,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"The TickTick connection changed since this was proposed — reject it and ask again.",
		);
		expect(
			screen.getByRole("button", { name: /create in ticktick/i }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: /edit/i })).toBeDisabled();
		const reject = screen.getByRole("button", { name: /dismiss/i });
		expect(reject).toBeEnabled();
		fireEvent.click(reject);
		expect(onDecide).toHaveBeenCalledWith("reject");
	});

	it("a fresh (non-stale) pending write derives no warning", () => {
		renderWithRouterContext(
			<ProposalCard
				proposal={{
					...base,
					ticktick_write: { state: "proposed", stale_connection: false },
				}}
				onDecide={() => {}}
			/>,
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /create in ticktick/i }),
		).toBeEnabled();
	});
});

describe("decided write states (live == reload: pure functions of the record)", () => {
	it("created renders the check + task id", () => {
		renderWithRouterContext(
			<ProposalCard
				proposal={{
					...base,
					status: "accepted",
					ticktick_write: { state: "created", task_id: "tt-42" },
				}}
				onDecide={() => {}}
			/>,
		);
		const row = document.querySelector('[data-ticktick-write="created"]');
		expect(row).not.toBeNull();
		expect(row).toHaveTextContent("Created in TickTick (task tt-42).");
	});

	it("created at the source cap adds the 200-item caveat", () => {
		const decided: PendingProposal = {
			...base,
			status: "accepted",
			ticktick_write: { state: "created", task_id: "tt-42" },
		};
		const { queryClient, rerender } = renderWithRouterContext(
			<ProposalCard proposal={decided} onDecide={() => {}} />,
		);
		queryClient.setQueryData([...TASKS_KEY_PREFIX, "conn-1"], {
			tasks: [],
			source_limit_reached: true,
		});
		rerender(<ProposalCard proposal={decided} onDecide={() => {}} />);
		expect(
			document.querySelector('[data-ticktick-write="created"]'),
		).toHaveTextContent(
			"May not appear in the Tasks view — TickTick returned its 200-item limit.",
		);
	});

	it("failed renders the HTTP status (and the sendless variant)", () => {
		const { rerender } = renderWithRouterContext(
			<ProposalCard
				proposal={{
					...base,
					status: "accepted",
					ticktick_write: { state: "failed", http_status: 401 },
				}}
				onDecide={() => {}}
			/>,
		);
		expect(
			document.querySelector('[data-ticktick-write="failed"]'),
		).toHaveTextContent("Not created — TickTick returned HTTP 401.");
		rerender(
			<ProposalCard
				proposal={{
					...base,
					status: "accepted",
					ticktick_write: { state: "failed" },
				}}
				onDecide={() => {}}
			/>,
		);
		expect(
			document.querySelector('[data-ticktick-write="failed"]'),
		).toHaveTextContent("Not created — the request could not be sent.");
	});

	it("unknown renders the check-TickTick copy — never success-shaped", () => {
		renderWithRouterContext(
			<ProposalCard
				proposal={{
					...base,
					status: "accepted",
					ticktick_write: { state: "unknown" },
				}}
				onDecide={() => {}}
			/>,
		);
		const row = document.querySelector('[data-ticktick-write="unknown"]');
		expect(row).toHaveTextContent(
			"Outcome unknown — check TickTick before re-asking.",
		);
		expect(row).not.toHaveTextContent(/created in ticktick/i);
	});

	it("a rejected write renders the existing dismissed pill", () => {
		renderWithRouterContext(
			<ProposalCard
				proposal={{
					...base,
					status: "rejected",
					ticktick_write: { state: "proposed", stale_connection: false },
				}}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByText("Dismissed.")).toBeInTheDocument();
	});
});

describe("the executing card + the bounded poll", () => {
	function seedHydratedExecuting(deadlineAt: number): void {
		seedRunTurn();
		rehydrateDecidedProposal({
			...base,
			payload: null,
			status: "accepted",
			ticktick_write: { state: "executing", deadline_at: deadlineAt },
		});
	}

	it("reload mid-B: hydrated executing renders creating… and reaches the recorded outcome with NO user action", async () => {
		let reads = 0;
		const overrides: Partial<WsClientService> = {
			threadGet: () => {
				reads += 1;
				// The first observation still says executing; the next reads the
				// recorded outcome (the watchdog settled server-side).
				return Effect.succeed(
					reads === 1
						? threadWithWriteSegment({
								state: "executing",
								deadline_at: Date.now() + 60_000,
							})
						: threadWithWriteSegment({ state: "created", task_id: "tt-9" }),
				);
			},
		};
		seedHydratedExecuting(Date.now() + 60_000);

		renderWithRouterContext(<AssistantProposals runId="run-1" />, {
			overrides,
		});

		expect(
			document.querySelector('[data-ticktick-write="executing"]'),
		).toHaveTextContent("Creating in TickTick…");

		await waitFor(
			() => {
				expect(
					document.querySelector('[data-ticktick-write="created"]'),
				).toHaveTextContent("Created in TickTick (task tt-9).");
			},
			{ timeout: 10_000 },
		);
		const readsAtSettle = reads;
		// The poll stops after settling (observation only, bounded).
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		expect(reads).toBe(readsAtSettle);
	}, 20_000);

	it("deadline residue: past deadline_at the poll stops, the card turns honest, and Resolve now re-decides to unknown", async () => {
		const overrides: Partial<WsClientService> = {
			// Any read still answers executing — settlement is suppressed.
			threadGet: () =>
				Effect.succeed(
					threadWithWriteSegment({
						state: "executing",
						deadline_at: Date.now() - 10_000,
					}),
				),
			proposalDecide: () =>
				Effect.succeed({
					status: "accepted" as const,
					ticktick_write: { state: "unknown" as const },
				}),
		};
		// The deadline already passed (watchdog residue).
		seedHydratedExecuting(Date.now() - 10_000);

		renderWithRouterContext(<AssistantProposals runId="run-1" />, {
			overrides,
		});

		await waitFor(() => {
			expect(
				document.querySelector('[data-ticktick-write="unresolved"]'),
			).toHaveTextContent(
				"Still unresolved — no outcome recorded; check TickTick before re-asking.",
			);
		});

		// Resolve now issues a re-decide (a WRITE — the past-bound belt): the
		// stubbed decide settles unknown and the card re-renders it.
		fireEvent.click(screen.getByRole("button", { name: /resolve now/i }));
		await waitFor(() => {
			expect(
				document.querySelector('[data-ticktick-write="unknown"]'),
			).toHaveTextContent("Outcome unknown — check TickTick before re-asking.");
		});
	});
});

describe("the edit form", () => {
	it("round-trips the FULL edited payload (replace semantics)", () => {
		const onDecide = vi.fn();
		renderWithRouterContext(
			<ProposalCard proposal={base} onDecide={onDecide} />,
		);
		fireEvent.click(screen.getByRole("button", { name: /edit/i }));
		fireEvent.change(screen.getByRole("textbox", { name: /title/i }), {
			target: { value: "buy oat milk" },
		});
		// Clearing the time sets is_all_day at local midnight in the zone.
		fireEvent.change(screen.getByLabelText(/time/i), {
			target: { value: "" },
		});
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		expect(onDecide).toHaveBeenCalledWith("edit", {
			title: "buy oat milk",
			note: "2%",
			due: {
				date: "2026-09-01T07:00:00.000Z",
				is_all_day: true,
				time_zone: "America/Los_Angeles",
			},
		});
	});

	it("an emptied title blocks Save", () => {
		renderWithRouterContext(
			<ProposalCard proposal={base} onDecide={() => {}} />,
		);
		fireEvent.click(screen.getByRole("button", { name: /edit/i }));
		fireEvent.change(screen.getByRole("textbox", { name: /title/i }), {
			target: { value: "   " },
		});
		expect(
			screen.getByRole("button", { name: /save changes/i }),
		).toBeDisabled();
	});
});

describe("invalidation on created (and only created)", () => {
	it("a created outcome invalidates the Tasks read; a failed one does not", async () => {
		const created: Partial<WsClientService> = {
			proposalDecide: () =>
				Effect.succeed({
					status: "accepted" as const,
					ticktick_write: { state: "created" as const, task_id: "tt-1" },
				}),
		};
		seedRunTurn();
		setPendingProposal(base);
		const { queryClient } = renderWithRouterContext(
			<AssistantProposals runId="run-1" />,
			{ overrides: created },
		);
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		fireEvent.click(
			screen.getByRole("button", { name: /create in ticktick/i }),
		);
		await waitFor(() => {
			expect(invalidate).toHaveBeenCalledWith({ queryKey: TASKS_KEY_PREFIX });
		});
		cleanup();
		resetChatStore();
		resetBridge();

		const failed: Partial<WsClientService> = {
			proposalDecide: () =>
				Effect.succeed({
					status: "accepted" as const,
					ticktick_write: { state: "failed" as const, http_status: 401 },
				}),
		};
		seedRunTurn();
		setPendingProposal(base);
		const { queryClient: queryClient2 } = renderWithRouterContext(
			<AssistantProposals runId="run-1" />,
			{ overrides: failed },
		);
		const invalidate2 = vi.spyOn(queryClient2, "invalidateQueries");
		fireEvent.click(
			screen.getByRole("button", { name: /create in ticktick/i }),
		);
		await waitFor(() => {
			expect(
				document.querySelector('[data-ticktick-write="failed"]'),
			).not.toBeNull();
		});
		expect(invalidate2).not.toHaveBeenCalledWith({
			queryKey: TASKS_KEY_PREFIX,
		});
	});
});
