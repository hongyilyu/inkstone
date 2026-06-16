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

	describe("reference_existing_entity_from_journal_entry", () => {
		const referenceProposal: PendingProposal = {
			proposal_id: "prop-ref",
			run_id: "run-ref",
			mutation_kind: "reference_existing_entity_from_journal_entry",
			payload: { entity_id: "entry-123", ref_id: "person-1" },
			rationale: "the user named an entity worth linking",
			status: "pending",
		};

		// reference's reviewCopy + rejectedCopy are otherwise unguarded — e2e asserts
		// only its summary/Link label/accepted copy, so a mistyped row here would slip
		// through the whole suite. Lock both strings the table owns for this kind.
		it("renders the reference review copy and Link/Keep labels", () => {
			render(<ProposalCard proposal={referenceProposal} onDecide={() => {}} />);
			expect(
				screen.getByText(
					"Inkstone wants to link an accepted Entity from this Journal Entry.",
				),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /link entity/i }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /keep current entry/i }),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /^edit$/i }),
			).not.toBeInTheDocument();
		});

		it("shows the reference rejected copy when kept", () => {
			render(
				<ProposalCard
					proposal={{ ...referenceProposal, status: "rejected" }}
					onDecide={() => {}}
				/>,
			);
			expect(
				screen.getByText("Kept current Journal Entry."),
			).toBeInTheDocument();
		});
	});

	describe("create_person", () => {
		const createPerson: PendingProposal = {
			proposal_id: "prop-person",
			run_id: "run-person",
			mutation_kind: "create_person",
			payload: {
				name: "Alice Carter",
				note: "Met at the conference.",
				aliases: ["Ali", "AC"],
			},
			rationale: "the user mentioned a new person",
			status: "pending",
		};

		it("renders a Person proposal with its name and detail fields", () => {
			render(<ProposalCard proposal={createPerson} onDecide={() => {}} />);
			expect(
				screen.getByText("Inkstone wants to add a Person."),
			).toBeInTheDocument();
			expect(screen.getAllByText("Alice Carter").length).toBeGreaterThan(0);
			expect(screen.getByText("Met at the conference.")).toBeInTheDocument();
			expect(screen.getByText(/Ali, AC/)).toBeInTheDocument();
			expect(
				screen.getByText("the user mentioned a new person"),
			).toBeInTheDocument();
			// create_person now offers inline Edit at the gate (slice 2).
			expect(
				screen.getByRole("button", { name: /^edit$/i }),
			).toBeInTheDocument();
		});

		it("calls onDecide('accept') when Add Person is clicked", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={createPerson} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /add person/i }));
			expect(onDecide).toHaveBeenCalledWith("accept");
		});

		it("calls onDecide('reject') when Dismiss is clicked", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={createPerson} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
			expect(onDecide).toHaveBeenCalledWith("reject");
		});

		it("opening Edit pre-fills Name/Note/Aliases from the proposed person", () => {
			render(<ProposalCard proposal={createPerson} onDecide={() => {}} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			expect(screen.getByRole("textbox", { name: /name/i })).toHaveValue(
				"Alice Carter",
			);
			expect(screen.getByRole("textbox", { name: /note/i })).toHaveValue(
				"Met at the conference.",
			);
			expect(screen.getByRole("textbox", { name: /aliases/i })).toHaveValue(
				"Ali, AC",
			);
		});

		it("editing Name then Save emits onDecide('edit', payload) preserving provenance", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard
					proposal={{
						...createPerson,
						payload: {
							name: "Alice Carter",
							note: "Met at the conference.",
							aliases: ["Ali", "AC"],
							source_journal_entry_id: "je-7",
						},
					}}
					onDecide={onDecide}
				/>,
			);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /name/i }), {
				target: { value: "Alice C. Carter" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			expect(onDecide).toHaveBeenCalledWith("edit", {
				name: "Alice C. Carter",
				note: "Met at the conference.",
				aliases: ["Ali", "AC"],
				source_journal_entry_id: "je-7",
			});
			expect(onDecide).toHaveBeenCalledTimes(1);
		});

		it("blanking the proposed Note omits note from the edited payload", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={createPerson} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /note/i }), {
				target: { value: "" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			const [, payload] = onDecide.mock.calls[0];
			expect("note" in payload).toBe(false);
		});

		it("disables Save when Name is blanked", () => {
			render(<ProposalCard proposal={createPerson} onDecide={() => {}} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /name/i }), {
				target: { value: "" },
			});
			expect(
				screen.getByRole("button", { name: /save changes/i }),
			).toBeDisabled();
		});
	});

	describe("create_project", () => {
		const createProject: PendingProposal = {
			proposal_id: "prop-project",
			run_id: "run-project",
			mutation_kind: "create_project",
			payload: {
				name: "Ship API v2 migration",
				outcome: "All clients on v2 by Q3.",
				status: "active",
			},
			rationale: "the user described an outcome-shaped project",
			status: "pending",
		};

		it("renders a Project proposal with its name and detail fields", () => {
			render(<ProposalCard proposal={createProject} onDecide={() => {}} />);
			expect(
				screen.getByText("Inkstone wants to add a Project."),
			).toBeInTheDocument();
			expect(
				screen.getAllByText("Ship API v2 migration").length,
			).toBeGreaterThan(0);
			expect(screen.getByText("All clients on v2 by Q3.")).toBeInTheDocument();
			expect(screen.getByText("active")).toBeInTheDocument();
			// create_project now offers inline Edit at the gate (slice 2).
			expect(
				screen.getByRole("button", { name: /^edit$/i }),
			).toBeInTheDocument();
		});

		it("calls onDecide('accept') when Add Project is clicked", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={createProject} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /add project/i }));
			expect(onDecide).toHaveBeenCalledWith("accept");
		});

		it("calls onDecide('reject') when Dismiss is clicked", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={createProject} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
			expect(onDecide).toHaveBeenCalledWith("reject");
		});

		it("opening Edit pre-fills Name/Outcome/Note/Status from the proposed project", () => {
			render(<ProposalCard proposal={createProject} onDecide={() => {}} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			expect(screen.getByRole("textbox", { name: /name/i })).toHaveValue(
				"Ship API v2 migration",
			);
			expect(screen.getByRole("textbox", { name: /outcome/i })).toHaveValue(
				"All clients on v2 by Q3.",
			);
			expect(screen.getByRole("combobox", { name: /status/i })).toHaveValue(
				"active",
			);
		});

		it("changing Status active→dropped stamps dropped_at, clears completed_at, and preserves provenance", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard
					proposal={{
						...createProject,
						payload: {
							name: "Ship API v2 migration",
							outcome: "All clients on v2 by Q3.",
							status: "active",
							completed_at: "2026-01-01T00:00:00",
							source_journal_entry_id: "je-9",
						},
					}}
					onDecide={onDecide}
				/>,
			);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("combobox", { name: /status/i }), {
				target: { value: "dropped" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			const [, payload] = onDecide.mock.calls[0];
			expect(payload.status).toBe("dropped");
			expect(payload.dropped_at).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
			);
			expect("completed_at" in payload).toBe(false);
			expect(payload.source_journal_entry_id).toBe("je-9");
		});

		it("supports the on_hold status option (distinct from Todo)", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={createProject} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("combobox", { name: /status/i }), {
				target: { value: "on_hold" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			const [, payload] = onDecide.mock.calls[0];
			expect(payload.status).toBe("on_hold");
			expect("completed_at" in payload).toBe(false);
			expect("dropped_at" in payload).toBe(false);
		});

		it("disables Save when Name is blanked", () => {
			render(<ProposalCard proposal={createProject} onDecide={() => {}} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /name/i }), {
				target: { value: "" },
			});
			expect(
				screen.getByRole("button", { name: /save changes/i }),
			).toBeDisabled();
		});
	});

	describe("create_todo", () => {
		const createTodo: PendingProposal = {
			proposal_id: "prop-todo",
			run_id: "run-todo",
			mutation_kind: "create_todo",
			payload: {
				todo: {
					title: "Email Alice about Project Y",
					note: "Send the migration plan.",
					project_id: "proj-1",
				},
				person_refs: [
					{ person_id: "alice-1", role: "related" },
					{ person_id: "bob-1", role: "waiting_on" },
				],
			},
			rationale: "the user named an explicit obligation",
			status: "pending",
		};

		it("renders a Todo proposal with its title, project link, and person refs", () => {
			render(<ProposalCard proposal={createTodo} onDecide={() => {}} />);
			expect(
				screen.getByText("Inkstone wants to add a Todo."),
			).toBeInTheDocument();
			expect(
				screen.getAllByText("Email Alice about Project Y").length,
			).toBeGreaterThan(0);
			expect(screen.getByText("Send the migration plan.")).toBeInTheDocument();
			expect(screen.getByText(/proj-1/)).toBeInTheDocument();
			expect(screen.getByText(/Related: alice-1/)).toBeInTheDocument();
			expect(screen.getByText(/Waiting on: bob-1/)).toBeInTheDocument();
			// create_todo now offers inline Edit at the gate (slice 1).
			expect(
				screen.getByRole("button", { name: /^edit$/i }),
			).toBeInTheDocument();
		});

		it("calls onDecide('accept') when Add Todo is clicked", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={createTodo} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /add todo/i }));
			expect(onDecide).toHaveBeenCalledWith("accept");
		});

		it("calls onDecide('reject') when Dismiss is clicked", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={createTodo} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
			expect(onDecide).toHaveBeenCalledWith("reject");
		});

		it("offers an Edit affordance for the create_todo proposal", () => {
			render(<ProposalCard proposal={createTodo} onDecide={() => {}} />);
			expect(
				screen.getByRole("button", { name: /^edit$/i }),
			).toBeInTheDocument();
		});

		it("opening Edit pre-fills Title/Note/Status from the proposed todo", () => {
			render(<ProposalCard proposal={createTodo} onDecide={() => {}} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			expect(screen.getByRole("textbox", { name: /title/i })).toHaveValue(
				"Email Alice about Project Y",
			);
			expect(screen.getByRole("textbox", { name: /note/i })).toHaveValue(
				"Send the migration plan.",
			);
			expect(screen.getByRole("combobox", { name: /status/i })).toHaveValue(
				"active",
			);
		});

		it("editing Title then Save emits onDecide('edit', payload) preserving provenance", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={createTodo} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /title/i }), {
				target: { value: "Email Alice about the Q3 migration" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			expect(onDecide).toHaveBeenCalledWith("edit", {
				todo: {
					title: "Email Alice about the Q3 migration",
					note: "Send the migration plan.",
					status: "active",
					project_id: "proj-1",
				},
				person_refs: [
					{ person_id: "alice-1", role: "related" },
					{ person_id: "bob-1", role: "waiting_on" },
				],
			});
			expect(onDecide).toHaveBeenCalledTimes(1);
		});

		it("changing Status active→completed emits completed_at and no dropped_at", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={createTodo} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("combobox", { name: /status/i }), {
				target: { value: "completed" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			const [, payload] = onDecide.mock.calls[0];
			expect(payload.todo.status).toBe("completed");
			expect(payload.todo.completed_at).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
			);
			expect("dropped_at" in payload.todo).toBe(false);
		});

		it("disables Save when Title is blanked", () => {
			render(<ProposalCard proposal={createTodo} onDecide={() => {}} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /title/i }), {
				target: { value: "" },
			});
			expect(
				screen.getByRole("button", { name: /save changes/i }),
			).toBeDisabled();
		});
	});

	describe("update_todo", () => {
		const updateTodo: PendingProposal = {
			proposal_id: "prop-update-todo",
			run_id: "run-update-todo",
			mutation_kind: "update_todo",
			payload: {
				todo_id: "todo-7",
				todo: { status: "completed", title: "Email Alice (done)" },
				set_person_refs: [{ person_id: "dave-1", role: "related" }],
				add_person_refs: [{ person_id: "carol-1", role: "waiting_on" }],
				remove_person_ids: ["bob-1"],
			},
			rationale: "the user marked the todo done",
			status: "pending",
		};

		it("renders an update Todo proposal summarizing the supplied changes", () => {
			render(<ProposalCard proposal={updateTodo} onDecide={() => {}} />);
			expect(
				screen.getByText("Inkstone wants to update a Todo."),
			).toBeInTheDocument();
			expect(screen.getByText(/todo-7/)).toBeInTheDocument();
			expect(screen.getByText("Email Alice (done)")).toBeInTheDocument();
			expect(screen.getByText("completed")).toBeInTheDocument();
			// set_person_refs renders under the "Set" label — distinct from add/remove,
			// so a dropped or mis-keyed set branch is caught, not just a missing line.
			expect(screen.getByText("Set")).toBeInTheDocument();
			expect(screen.getByText(/Related: dave-1/)).toBeInTheDocument();
			expect(screen.getByText(/Waiting on: carol-1/)).toBeInTheDocument();
			expect(screen.getByText(/bob-1/)).toBeInTheDocument();
			// update_todo now offers inline Edit at the gate (slice 3).
			expect(
				screen.getByRole("button", { name: /^edit$/i }),
			).toBeInTheDocument();
		});

		it("calls onDecide('accept') when Update Todo is clicked", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={updateTodo} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /update todo/i }));
			expect(onDecide).toHaveBeenCalledWith("accept");
		});

		it("calls onDecide('reject') when Dismiss is clicked", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={updateTodo} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
			expect(onDecide).toHaveBeenCalledWith("reject");
		});

		it("editing Title then Save emits the partial preserving todo_id and all ref lists", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={updateTodo} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /title/i }), {
				target: { value: "Email Alice about the Q3 migration" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			expect(onDecide).toHaveBeenCalledWith("edit", {
				todo_id: "todo-7",
				todo: {
					title: "Email Alice about the Q3 migration",
					status: "completed",
				},
				set_person_refs: [{ person_id: "dave-1", role: "related" }],
				add_person_refs: [{ person_id: "carol-1", role: "waiting_on" }],
				remove_person_ids: ["bob-1"],
			});
			expect(onDecide).toHaveBeenCalledTimes(1);
		});

		it("blanking a proposed Note omits the note key from the edited partial", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard
					proposal={{
						...updateTodo,
						payload: {
							todo_id: "todo-7",
							todo: { title: "Keep title", note: "Drop me" },
						},
					}}
					onDecide={onDecide}
				/>,
			);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /note/i }), {
				target: { value: "" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			const [, payload] = onDecide.mock.calls[0];
			expect("note" in payload.todo).toBe(false);
		});

		it("hides the Status control when the proposed partial carries no status", () => {
			render(
				<ProposalCard
					proposal={{
						...updateTodo,
						payload: {
							todo_id: "todo-7",
							todo: { title: "Rename me" },
						},
					}}
					onDecide={() => {}}
				/>,
			);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			expect(
				screen.getByRole("textbox", { name: /title/i }),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("combobox", { name: /status/i }),
			).not.toBeInTheDocument();
		});

		it("disables Save when a proposed Title is blanked", () => {
			render(<ProposalCard proposal={updateTodo} onDecide={() => {}} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /title/i }), {
				target: { value: "" },
			});
			expect(
				screen.getByRole("button", { name: /save changes/i }),
			).toBeDisabled();
		});
	});

	describe("update_person", () => {
		const updatePerson: PendingProposal = {
			proposal_id: "prop-update-person",
			run_id: "run-update-person",
			mutation_kind: "update_person",
			payload: {
				entity_id: "person-7",
				name: "Alice Carter",
				note: "Now leads the daycare committee.",
				aliases: ["Ali", "AC"],
			},
			rationale: "the user corrected Alice's note",
			status: "pending",
		};

		it("renders an update Person proposal with its review copy, Update label, and detail — not the journal fallback", () => {
			render(<ProposalCard proposal={updatePerson} onDecide={() => {}} />);
			expect(
				screen.getByText("Inkstone wants to update a Person."),
			).toBeInTheDocument();
			// A degraded fallback would echo the raw kind — assert it does NOT.
			expect(
				screen.queryByText(/wants to create a update_person/i),
			).not.toBeInTheDocument();
			expect(screen.getAllByText("Alice Carter").length).toBeGreaterThan(0);
			expect(
				screen.getByText("Now leads the daycare committee."),
			).toBeInTheDocument();
			expect(screen.getByText(/Ali, AC/)).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /update person/i }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /^edit$/i }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /dismiss/i }),
			).toBeInTheDocument();
		});

		it("opening Edit pre-fills Name/Note/Aliases from the proposed person", () => {
			render(<ProposalCard proposal={updatePerson} onDecide={() => {}} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			expect(screen.getByRole("textbox", { name: /name/i })).toHaveValue(
				"Alice Carter",
			);
			expect(screen.getByRole("textbox", { name: /note/i })).toHaveValue(
				"Now leads the daycare committee.",
			);
			expect(screen.getByRole("textbox", { name: /aliases/i })).toHaveValue(
				"Ali, AC",
			);
		});

		it("editing Name then Save emits onDecide('edit', payload) preserving entity_id", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={updatePerson} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /name/i }), {
				target: { value: "Alice C. Carter" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			expect(onDecide).toHaveBeenCalledWith("edit", {
				entity_id: "person-7",
				name: "Alice C. Carter",
				note: "Now leads the daycare committee.",
				aliases: ["Ali", "AC"],
			});
			expect(onDecide).toHaveBeenCalledTimes(1);
		});

		it("blanking the proposed Note omits note but keeps entity_id (full-replace ⇒ omit ≡ cleared)", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={updatePerson} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /note/i }), {
				target: { value: "" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			const [, payload] = onDecide.mock.calls[0];
			expect("note" in payload).toBe(false);
			expect(payload.entity_id).toBe("person-7");
		});

		it("disables Save when Name is blanked", () => {
			render(<ProposalCard proposal={updatePerson} onDecide={() => {}} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /name/i }), {
				target: { value: "" },
			});
			expect(
				screen.getByRole("button", { name: /save changes/i }),
			).toBeDisabled();
		});
	});

	describe("update_project", () => {
		const updateProject: PendingProposal = {
			proposal_id: "prop-update-project",
			run_id: "run-update-project",
			mutation_kind: "update_project",
			payload: {
				entity_id: "project-7",
				name: "Ship API v2",
				outcome: "All clients on v2 by Q3.",
				status: "active",
			},
			rationale: "the user re-scoped the project",
			status: "pending",
		};

		it("renders an update Project proposal with its review copy, Update label, and detail — not the journal fallback", () => {
			render(<ProposalCard proposal={updateProject} onDecide={() => {}} />);
			expect(
				screen.getByText("Inkstone wants to update a Project."),
			).toBeInTheDocument();
			expect(
				screen.queryByText(/wants to create a update_project/i),
			).not.toBeInTheDocument();
			expect(screen.getAllByText("Ship API v2").length).toBeGreaterThan(0);
			expect(screen.getByText("All clients on v2 by Q3.")).toBeInTheDocument();
			expect(screen.getByText("active")).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /update project/i }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /^edit$/i }),
			).toBeInTheDocument();
		});

		it("opening Edit pre-fills Name/Outcome/Status from the proposed project", () => {
			render(<ProposalCard proposal={updateProject} onDecide={() => {}} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			expect(screen.getByRole("textbox", { name: /name/i })).toHaveValue(
				"Ship API v2",
			);
			expect(screen.getByRole("textbox", { name: /outcome/i })).toHaveValue(
				"All clients on v2 by Q3.",
			);
			expect(screen.getByRole("combobox", { name: /status/i })).toHaveValue(
				"active",
			);
		});

		it("changing Status active→on_hold clears terminal timestamps and preserves entity_id", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard
					proposal={{
						...updateProject,
						payload: {
							entity_id: "project-7",
							name: "Ship API v2",
							status: "active",
							completed_at: "2026-01-01T00:00:00",
							review_every: { interval: 1, unit: "week" },
						},
					}}
					onDecide={onDecide}
				/>,
			);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("combobox", { name: /status/i }), {
				target: { value: "on_hold" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			const [, payload] = onDecide.mock.calls[0];
			expect(payload.status).toBe("on_hold");
			expect("completed_at" in payload).toBe(false);
			expect("dropped_at" in payload).toBe(false);
			// entity_id + the review cadence ride untouched under full replace.
			expect(payload.entity_id).toBe("project-7");
			expect(payload.review_every).toEqual({ interval: 1, unit: "week" });
		});

		it("disables Save when Name is blanked", () => {
			render(<ProposalCard proposal={updateProject} onDecide={() => {}} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /name/i }), {
				target: { value: "" },
			});
			expect(
				screen.getByRole("button", { name: /save changes/i }),
			).toBeDisabled();
		});
	});

	// Core forwards the RAW, unvalidated model arguments to the card: park_on_proposal
	// (crates/core/src/worker/run.rs) stores params verbatim, and the proposal-get path
	// defaults a missing `payload` to null. A real LLM can omit `payload` or emit a
	// wrong-typed field, so every GTD accessor must degrade — never crash on render.
	describe("malformed GTD payloads degrade without crashing", () => {
		it("renders a create_person with a null payload and keeps Add Person working", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard
					proposal={{
						proposal_id: "prop-bad-person",
						run_id: "run-bad-person",
						mutation_kind: "create_person",
						payload: null,
						rationale: null,
						status: "pending",
					}}
					onDecide={onDecide}
				/>,
			);
			const accept = screen.getByRole("button", { name: /add person/i });
			expect(accept).toBeInTheDocument();
			fireEvent.click(accept);
			expect(onDecide).toHaveBeenCalledWith("accept");
		});

		it("renders a create_project with a null payload and keeps Add Project working", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard
					proposal={{
						proposal_id: "prop-bad-project",
						run_id: "run-bad-project",
						mutation_kind: "create_project",
						payload: null,
						rationale: null,
						status: "pending",
					}}
					onDecide={onDecide}
				/>,
			);
			const accept = screen.getByRole("button", { name: /add project/i });
			expect(accept).toBeInTheDocument();
			fireEvent.click(accept);
			expect(onDecide).toHaveBeenCalledWith("accept");
		});

		it("renders a create_todo with a null payload and keeps Add Todo working", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard
					proposal={{
						proposal_id: "prop-bad-todo",
						run_id: "run-bad-todo",
						mutation_kind: "create_todo",
						payload: null,
						rationale: null,
						status: "pending",
					}}
					onDecide={onDecide}
				/>,
			);
			const accept = screen.getByRole("button", { name: /add todo/i });
			expect(accept).toBeInTheDocument();
			fireEvent.click(accept);
			expect(onDecide).toHaveBeenCalledWith("accept");
		});

		it("renders a create_todo with an empty payload object without crashing", () => {
			render(
				<ProposalCard
					proposal={{
						proposal_id: "prop-empty-todo",
						run_id: "run-empty-todo",
						mutation_kind: "create_todo",
						payload: {},
						rationale: null,
						status: "pending",
					}}
					onDecide={() => {}}
				/>,
			);
			expect(
				screen.getByRole("button", { name: /add todo/i }),
			).toBeInTheDocument();
		});

		it("renders a create_todo with person_refs as a non-array string without crashing", () => {
			render(
				<ProposalCard
					proposal={{
						proposal_id: "prop-bad-refs",
						run_id: "run-bad-refs",
						mutation_kind: "create_todo",
						payload: {
							todo: { title: "Ping Alice" },
							person_refs: "alice",
						},
						rationale: null,
						status: "pending",
					}}
					onDecide={() => {}}
				/>,
			);
			expect(screen.getAllByText("Ping Alice").length).toBeGreaterThan(0);
			expect(
				screen.getByRole("button", { name: /add todo/i }),
			).toBeInTheDocument();
		});

		it("renders a create_person with aliases as a non-array without crashing", () => {
			render(
				<ProposalCard
					proposal={{
						proposal_id: "prop-bad-aliases",
						run_id: "run-bad-aliases",
						mutation_kind: "create_person",
						payload: { name: "Alice", aliases: "Ali" },
						rationale: null,
						status: "pending",
					}}
					onDecide={() => {}}
				/>,
			);
			expect(screen.getAllByText("Alice").length).toBeGreaterThan(0);
			expect(
				screen.getByRole("button", { name: /add person/i }),
			).toBeInTheDocument();
		});

		it("renders an update_todo with a null payload and keeps Update Todo working", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard
					proposal={{
						proposal_id: "prop-bad-update",
						run_id: "run-bad-update",
						mutation_kind: "update_todo",
						payload: null,
						rationale: null,
						status: "pending",
					}}
					onDecide={onDecide}
				/>,
			);
			const accept = screen.getByRole("button", { name: /update todo/i });
			expect(accept).toBeInTheDocument();
			fireEvent.click(accept);
			expect(onDecide).toHaveBeenCalledWith("accept");
		});

		it("renders an update_todo with non-array ref fields without crashing", () => {
			render(
				<ProposalCard
					proposal={{
						proposal_id: "prop-bad-update-refs",
						run_id: "run-bad-update-refs",
						mutation_kind: "update_todo",
						payload: {
							todo_id: "todo-9",
							set_person_refs: "carol",
							add_person_refs: { person_id: "dave" },
							remove_person_ids: "bob",
						},
						rationale: null,
						status: "pending",
					}}
					onDecide={() => {}}
				/>,
			);
			expect(screen.getByText(/todo-9/)).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /update todo/i }),
			).toBeInTheDocument();
		});

		// `mutation_kind` is an unvalidated wire string (Core stores it raw at park
		// time), so the presentation lookup must degrade ANY unrecognized kind to the
		// fallback — including a prototype key like "constructor"/"toString", which a
		// bare `record[kind] ?? fallback` would wrongly resolve to an inherited
		// Object.prototype member and crash the card.
		it("renders a prototype-key mutation_kind through the fallback without crashing", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard
					proposal={{
						proposal_id: "prop-proto",
						run_id: "run-proto",
						mutation_kind: "constructor",
						payload: { body: [{ type: "text", text: "Body text" }] },
						rationale: null,
						status: "pending",
					}}
					onDecide={onDecide}
				/>,
			);
			expect(
				screen.getByText("Inkstone wants to create a constructor."),
			).toBeInTheDocument();
			const accept = screen.getByRole("button", { name: /add journal entry/i });
			expect(accept).toBeInTheDocument();
			fireEvent.click(accept);
			expect(onDecide).toHaveBeenCalledWith("accept");
		});

		it("renders an unrecognized mutation_kind through the fallback", () => {
			render(
				<ProposalCard
					proposal={{
						proposal_id: "prop-unknown",
						run_id: "run-unknown",
						mutation_kind: "create_bookmark",
						payload: null,
						rationale: null,
						status: "pending",
					}}
					onDecide={() => {}}
				/>,
			);
			expect(
				screen.getByText("Inkstone wants to create a create_bookmark."),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /add journal entry/i }),
			).toBeInTheDocument();
		});
	});
});
