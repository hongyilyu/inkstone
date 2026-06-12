import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingProposal } from "@/store/chat";
import { ProposalCard } from "./ProposalCard.js";

const base: PendingProposal = {
	proposal_id: "prop-1",
	run_id: "run-1",
	mutation_kind: "create_journal_entry",
	payload: {
		occurred_at: "2026-06-10T10:30:00",
		body: [{ type: "text", text: "Bought milk after daycare pickup." }],
	},
	rationale: "the user shared a journal-worthy moment",
	status: "pending",
};

const deleteProposal: PendingProposal = {
	proposal_id: "prop-2",
	run_id: "run-2",
	mutation_kind: "delete_journal_entry",
	payload: {
		entity_id: "entry-123",
	},
	rationale: "the user asked to remove this entry",
	status: "pending",
};

const updateProposal: PendingProposal & {
	review_context: {
		current_journal_entry: {
			entity_id: string;
			occurred_at: string;
			ended_at?: string;
			body: Array<{ type: "text"; text: string }>;
		};
	};
} = {
	proposal_id: "prop-3",
	run_id: "run-3",
	mutation_kind: "update_journal_entry",
	payload: {
		entity_id: "entry-123",
		occurred_at: "2026-06-10T11:00:00",
		ended_at: "2026-06-10T11:15:00",
		body: [
			{ type: "text", text: "Bought milk and bread after daycare pickup." },
		],
	},
	review_context: {
		current_journal_entry: {
			entity_id: "entry-123",
			occurred_at: "2026-06-10T10:30:00",
			body: [{ type: "text", text: "Bought milk after daycare pickup." }],
		},
	},
	rationale: "the user corrected the original journal entry",
	status: "pending",
};

const updateProposalMissingEntityId: PendingProposal & {
	review_context: {
		current_journal_entry: {
			entity_id: string;
			occurred_at: string;
			ended_at?: string;
			body: Array<{ type: "text"; text: string }>;
		};
	};
} = {
	...updateProposal,
	payload: {
		occurred_at: "2026-06-10T11:00:00",
		ended_at: "2026-06-10T11:15:00",
		body: [
			{ type: "text", text: "Bought milk and bread after daycare pickup." },
		],
	},
};

const deleteProposalWithContext: PendingProposal & {
	review_context: {
		current_journal_entry: {
			entity_id: string;
			occurred_at: string;
			ended_at?: string;
			body: Array<{ type: "text"; text: string }>;
		};
	};
} = {
	...deleteProposal,
	review_context: {
		current_journal_entry: {
			entity_id: "entry-123",
			occurred_at: "2026-06-10T10:30:00",
			body: [{ type: "text", text: "Bought milk after daycare pickup." }],
		},
	},
};

describe("ProposalCard", () => {
	afterEach(cleanup);

	it("renders a Journal Entry proposal with its body, rationale, and actions", () => {
		render(<ProposalCard proposal={base} onDecide={() => {}} />);
		expect(screen.getAllByText(/bought milk/i).length).toBeGreaterThan(0);
		expect(
			screen.getByText("the user shared a journal-worthy moment"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /add journal entry/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /dismiss/i }),
		).toBeInTheDocument();
	});

	it("calls onDecide('accept') when Add Journal Entry is clicked", () => {
		const onDecide = vi.fn();
		render(<ProposalCard proposal={base} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: /add journal entry/i }));
		expect(onDecide).toHaveBeenCalledWith("accept");
	});

	it("calls onDecide('reject') when Dismiss is clicked", () => {
		const onDecide = vi.fn();
		render(<ProposalCard proposal={base} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
		expect(onDecide).toHaveBeenCalledWith("reject");
	});

	it("disables the actions while deciding", () => {
		render(
			<ProposalCard
				proposal={{ ...base, status: "deciding" }}
				onDecide={() => {}}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /add journal entry/i }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: /dismiss/i })).toBeDisabled();
	});

	it("shows a progress affordance on the chosen action while deciding", () => {
		const onDecide = vi.fn();
		const { rerender } = render(
			<ProposalCard proposal={base} onDecide={onDecide} />,
		);
		fireEvent.click(screen.getByRole("button", { name: /add journal entry/i }));
		rerender(
			<ProposalCard
				proposal={{ ...base, status: "deciding" }}
				onDecide={onDecide}
			/>,
		);
		const accept = screen.getByRole("button", { name: /adding/i });
		expect(accept).toBeDisabled();
		expect(screen.getByRole("button", { name: /dismiss/i })).toBeDisabled();
	});

	it("collapses to the accepted state", () => {
		render(
			<ProposalCard
				proposal={{ ...base, status: "accepted" }}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByText(/added to journal/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /add journal entry/i }),
		).not.toBeInTheDocument();
	});

	it("shows the rejected state", () => {
		render(
			<ProposalCard
				proposal={{ ...base, status: "rejected" }}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByText(/dismissed/i)).toBeInTheDocument();
	});

	it("offers a retry in the error state", () => {
		const onDecide = vi.fn();
		render(
			<ProposalCard
				proposal={{ ...base, status: "error" }}
				onDecide={onDecide}
			/>,
		);
		expect(screen.getByText(/couldn't apply/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(onDecide).toHaveBeenCalledWith("accept");
	});

	it("retries a failed Dismiss as reject, not accept", () => {
		const onDecide = vi.fn();
		const { rerender } = render(
			<ProposalCard proposal={base} onDecide={onDecide} />,
		);
		// Dismiss is attempted, the decide goes in flight, then fails.
		fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
		expect(onDecide).toHaveBeenLastCalledWith("reject");
		rerender(
			<ProposalCard
				proposal={{ ...base, status: "error" }}
				onDecide={onDecide}
			/>,
		);
		// "Try again" must re-issue the SAME decision (reject) — never a silent
		// accept that would create the Journal Entry the user rejected.
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(onDecide).toHaveBeenLastCalledWith("reject");
		expect(onDecide).not.toHaveBeenCalledWith("accept");
	});

	it("retries a failed Save as edit with the same edited payload", () => {
		const onDecide = vi.fn();
		const { rerender } = render(
			<ProposalCard proposal={base} onDecide={onDecide} />,
		);
		fireEvent.click(screen.getByRole("button", { name: /edit/i }));
		fireEvent.change(screen.getByRole("textbox", { name: /body/i }), {
			target: { value: "Bought oat milk after daycare pickup." },
		});
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		const editedPayload = {
			occurred_at: "2026-06-10T10:30:00",
			body: [{ type: "text", text: "Bought oat milk after daycare pickup." }],
		};
		expect(onDecide).toHaveBeenLastCalledWith("edit", editedPayload);
		rerender(
			<ProposalCard
				proposal={{ ...base, status: "error" }}
				onDecide={onDecide}
			/>,
		);
		// Retrying an edit must re-issue edit WITH the user's payload — not accept,
		// which would silently revert the edits to the model's original.
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(onDecide).toHaveBeenLastCalledWith("edit", editedPayload);
		expect(onDecide).not.toHaveBeenCalledWith("accept");
	});

	it("allows retrying a failed Dismiss even when the payload is invalid", () => {
		const onDecide = vi.fn();
		const invalid = {
			...base,
			payload: { occurred_at: "2026-06-10", body: [] },
		};
		const { rerender } = render(
			<ProposalCard proposal={invalid} onDecide={onDecide} />,
		);
		fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
		rerender(
			<ProposalCard
				proposal={{ ...invalid, status: "error" }}
				onDecide={onDecide}
			/>,
		);
		// A reject retry does not depend on payload validity (only accept/edit do).
		const retry = screen.getByRole("button", { name: /try again/i });
		expect(retry).not.toBeDisabled();
		fireEvent.click(retry);
		expect(onDecide).toHaveBeenLastCalledWith("reject");
	});

	it("blocks applying an invalid Journal Entry proposal until edited", () => {
		render(
			<ProposalCard
				proposal={{
					...base,
					payload: {
						occurred_at: "2026-06-10",
						body: [],
					},
				}}
				onDecide={() => {}}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /add journal entry/i }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: /edit/i })).not.toBeDisabled();
		expect(screen.getByText(/edit required fields/i)).toBeInTheDocument();
	});

	it("keeps Edit available when an invalid proposal is in the error state", () => {
		render(
			<ProposalCard
				proposal={{
					...base,
					status: "error",
					payload: {
						occurred_at: "2026-06-10",
						body: [],
					},
				}}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByRole("button", { name: /try again/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /edit/i })).not.toBeDisabled();
	});

	it("opens the inline edit form with the proposed fields pre-filled", () => {
		render(<ProposalCard proposal={base} onDecide={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /edit/i }));
		expect(screen.getByRole("textbox", { name: /occurred at/i })).toHaveValue(
			"2026-06-10T10:30:00",
		);
		expect(screen.getByRole("textbox", { name: /body/i })).toHaveValue(
			"Bought milk after daycare pickup.",
		);
		expect(
			screen.getByRole("button", { name: /save changes/i }),
		).toBeInTheDocument();
	});

	it("closes the inline edit form without deciding when Cancel is clicked", () => {
		const onDecide = vi.fn();
		render(<ProposalCard proposal={base} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: /edit/i }));
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		expect(
			screen.queryByRole("button", { name: /save changes/i }),
		).not.toBeInTheDocument();
		expect(onDecide).not.toHaveBeenCalled();
	});

	it("saves the edited payload via onDecide('edit', payload)", () => {
		const onDecide = vi.fn();
		render(<ProposalCard proposal={base} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: /edit/i }));
		fireEvent.change(screen.getByRole("textbox", { name: /body/i }), {
			target: { value: "Bought oat milk after daycare pickup." },
		});
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		expect(onDecide).toHaveBeenCalledWith("edit", {
			occurred_at: "2026-06-10T10:30:00",
			body: [{ type: "text", text: "Bought oat milk after daycare pickup." }],
		});
		expect(onDecide).toHaveBeenCalledTimes(1);
		expect(
			screen.queryByRole("button", { name: /save changes/i }),
		).not.toBeInTheDocument();
	});

	it("disables Save when required fields are empty", () => {
		render(<ProposalCard proposal={base} onDecide={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /edit/i }));
		fireEvent.change(screen.getByRole("textbox", { name: /body/i }), {
			target: { value: "" },
		});
		expect(
			screen.getByRole("button", { name: /save changes/i }),
		).toBeDisabled();
	});

	it("renders delete-specific copy and actions without Edit", () => {
		render(
			<ProposalCard proposal={deleteProposalWithContext} onDecide={() => {}} />,
		);
		expect(
			screen.getByText("Inkstone wants to delete a Journal Entry."),
		).toBeInTheDocument();
		expect(screen.getByText("Current entry")).toBeInTheDocument();
		expect(
			screen.getByText("Bought milk after daycare pickup."),
		).toBeInTheDocument();
		expect(
			screen.getByText("the user asked to remove this entry"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /delete journal entry/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /keep journal entry/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /edit/i }),
		).not.toBeInTheDocument();
	});

	it("keeps delete proposals legible when current-entry context is unavailable", () => {
		render(<ProposalCard proposal={deleteProposal} onDecide={() => {}} />);

		expect(
			screen.getByText("Inkstone wants to delete a Journal Entry."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Current entry details unavailable."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /delete journal entry/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /keep journal entry/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /edit/i }),
		).not.toBeInTheDocument();
	});

	it("calls onDecide for delete proposal accept and reject actions", () => {
		const onDecide = vi.fn();
		render(
			<ProposalCard proposal={deleteProposalWithContext} onDecide={onDecide} />,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /delete journal entry/i }),
		);
		expect(onDecide).toHaveBeenCalledWith("accept");
		cleanup();
		render(
			<ProposalCard proposal={deleteProposalWithContext} onDecide={onDecide} />,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /keep journal entry/i }),
		);
		expect(onDecide).toHaveBeenCalledWith("reject");
	});

	it("collapses accepted and rejected delete proposals to delete-specific copy", () => {
		const { rerender } = render(
			<ProposalCard
				proposal={{ ...deleteProposal, status: "accepted" }}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByText(/deleted from journal/i)).toBeInTheDocument();
		rerender(
			<ProposalCard
				proposal={{ ...deleteProposal, status: "rejected" }}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByText(/kept in journal/i)).toBeInTheDocument();
	});

	it("renders update proposals with current and proposed journal entry values", () => {
		render(<ProposalCard proposal={updateProposal} onDecide={() => {}} />);
		expect(
			screen.getByText("Inkstone wants to update a Journal Entry."),
		).toBeInTheDocument();
		expect(screen.getByText("Current entry")).toBeInTheDocument();
		expect(screen.getByText("Proposed entry")).toBeInTheDocument();
		expect(
			screen.getByText("the user corrected the original journal entry"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /update journal entry/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /keep current entry/i }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Bought milk after daycare pickup."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Bought milk and bread after daycare pickup."),
		).toBeInTheDocument();
		expect(screen.getByText("2026-06-10T10:30:00")).toBeInTheDocument();
		expect(screen.getByText("2026-06-10T11:00:00")).toBeInTheDocument();
		expect(screen.getByText("2026-06-10T11:15:00")).toBeInTheDocument();
	});

	it("renders entity_ref placeholders in current-entry context", () => {
		const mixedContextProposal: PendingProposal = {
			...updateProposal,
			review_context: {
				current_journal_entry: {
					entity_id: "entry-123",
					occurred_at: "2026-06-10T10:30:00",
					body: [
						{ type: "text", text: "Met " },
						{
							type: "entity_ref",
							ref_id: "01900000-0000-7000-8000-000000000111",
						},
						{ type: "text", text: " at school." },
					],
				},
			},
		};

		render(
			<ProposalCard proposal={mixedContextProposal} onDecide={() => {}} />,
		);

		expect(screen.getByText("Met [entity_ref] at school.")).toBeInTheDocument();
	});

	it("disables inline edit when a body contains entity_ref nodes", () => {
		const mixedBodyProposal: PendingProposal = {
			...updateProposal,
			payload: {
				entity_id: "entry-123",
				occurred_at: "2026-06-10T11:00:00",
				body: [
					{ type: "text", text: "Met " },
					{
						type: "entity_ref",
						ref_id: "01900000-0000-7000-8000-000000000111",
					},
					{ type: "text", text: " at school." },
				],
			},
		};

		render(<ProposalCard proposal={mixedBodyProposal} onDecide={() => {}} />);

		expect(
			screen.queryByRole("button", { name: /edit/i }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /update journal entry/i }),
		).toBeInTheDocument();
	});

	it("submits the full edited update journal entry payload", () => {
		const onDecide = vi.fn();
		render(<ProposalCard proposal={updateProposal} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: /edit/i }));
		fireEvent.change(screen.getByRole("textbox", { name: /occurred at/i }), {
			target: { value: "2026-06-10T11:05:00" },
		});
		fireEvent.change(screen.getByRole("textbox", { name: /ended at/i }), {
			target: { value: "2026-06-10T11:20:00" },
		});
		fireEvent.change(screen.getByRole("textbox", { name: /body/i }), {
			target: {
				value: "Bought milk, bread, and berries after daycare pickup.",
			},
		});
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		expect(onDecide).toHaveBeenCalledWith("edit", {
			entity_id: "entry-123",
			occurred_at: "2026-06-10T11:05:00",
			ended_at: "2026-06-10T11:20:00",
			body: [
				{
					type: "text",
					text: "Bought milk, bread, and berries after daycare pickup.",
				},
			],
		});
	});

	it("blocks update proposals missing entity_id from accept and edit submission", () => {
		const onDecide = vi.fn();
		render(
			<ProposalCard
				proposal={updateProposalMissingEntityId}
				onDecide={onDecide}
			/>,
		);

		expect(
			screen.getByRole("button", { name: /update journal entry/i }),
		).toBeDisabled();
		expect(
			screen.getByText(/entity id must not be empty/i),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /edit/i }));
		const save = screen.getByRole("button", { name: /save changes/i });
		expect(save).toBeDisabled();
		fireEvent.click(save);
		expect(onDecide).not.toHaveBeenCalled();
	});

	it("disables retry for errored update proposals missing entity_id", () => {
		const onDecide = vi.fn();
		render(
			<ProposalCard
				proposal={{ ...updateProposalMissingEntityId, status: "error" }}
				onDecide={onDecide}
			/>,
		);

		const retry = screen.getByRole("button", { name: /try again/i });
		expect(retry).toBeDisabled();
		expect(
			screen.getByText(/entity id must not be empty/i),
		).toBeInTheDocument();

		fireEvent.click(retry);
		expect(onDecide).not.toHaveBeenCalled();
	});
});
