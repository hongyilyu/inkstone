import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryItem } from "@/lib/libraryItems";
import { isGtdEditKind } from "@/lib/proposalEdit";
import type { PendingProposal } from "@/store/chat";
import { ProposalCard } from "@/components/ProposalCard.js";
import { PROPOSAL_VIEWS } from "@/components/proposalViews.js";

// The decided card (ADR-0044 entity_id amendment) resolves its named entity live
// from the warm library-items cache and deep-links to it via `useNavigate`. Mock
// both seams so the card renders without a QueryClient/RuntimeProvider or a real
// router: the hook returns whatever items the test seeds, navigate is a spy.
const { navigate, libraryItems } = vi.hoisted(() => ({
	navigate: vi.fn(),
	libraryItems: { current: [] as LibraryItem[] },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useNavigate: () => navigate };
});

vi.mock("@/lib/hooks/useLibraryItems", () => ({
	useLibraryItems: () => ({ data: libraryItems.current }),
}));

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
		expect(screen.getByText(/fix before saving/i)).toBeInTheDocument();
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

	it("renders the journal edit fields through the shared field primitives", () => {
		const { container } = render(
			<ProposalCard proposal={updateProposal} onDecide={() => {}} />,
		);
		fireEvent.click(screen.getByRole("button", { name: /edit/i }));

		// The dead `bg-card-surface/40` class painted no fill (no such token —
		// `card-surface` is DESIGN.md's alias for `card`). The shared primitives
		// carry the canonical `bg-card/40` chrome instead.
		expect(container.querySelector(".bg-card-surface\\/40")).toBeNull();

		const body = screen.getByRole("textbox", { name: /body/i });
		const occurredAt = screen.getByRole("textbox", { name: /occurred at/i });
		const endedAt = screen.getByRole("textbox", { name: /ended at/i });
		// Each field's wrapper (the EditorField primitive's bordered box) supplies
		// the `bg-card/40` fill the dead class never painted.
		for (const field of [body, occurredAt, endedAt]) {
			const wrapper = field.parentElement;
			expect(wrapper?.className).toContain("bg-card/40");
		}

		// Body stays editable and focuses on open (the journal form's affordance).
		fireEvent.change(body, {
			target: { value: "Bought oat milk after daycare pickup." },
		});
		expect(body).toHaveValue("Bought oat milk after daycare pickup.");
		expect(body).toHaveFocus();
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
			// reference routes to renderNoBody — pin the empty body so a future re-wire
			// to a journal strategy (which would render a "Proposed entry" section off
			// this body-less payload) fails here instead of slipping through.
			expect(
				screen.queryByText(/Proposed entry|Current entry/),
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
			// Status renders as its humanized label, not the raw enum.
			expect(screen.getByText("Active")).toBeInTheDocument();
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
				source_journal_entry_id: "je-7",
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
				// Provenance rides untouched through the overlay clone — the field
				// this test's name promises.
				source_journal_entry_id: "je-7",
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
			// The raw todo_id UUID is NOT surfaced (unreadable, redundant with the
			// heading); only the fields that actually change are shown.
			expect(screen.queryByText(/todo-7/)).toBeNull();
			expect(screen.getByText("Email Alice (done)")).toBeInTheDocument();
			// Status renders as its humanized label, not the raw enum.
			expect(screen.getByText("Completed")).toBeInTheDocument();
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

		it("calls onDecide('reject') when Keep current Todo is clicked", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={updateTodo} onDecide={onDecide} />);
			fireEvent.click(
				screen.getByRole("button", { name: /keep current todo/i }),
			);
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

		// The update_todo Status select is wired through its OWN setter
		// (setUpdateTodoDraft) and overlay (overlayUpdateTodo), distinct from
		// create_todo's — so drive the card's select→overlay path and assert the
		// coupled timestamp, not just the unit-tested overlay.
		it("changing Status completed→active clears completed_at in the edited partial", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={updateTodo} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("combobox", { name: /status/i }), {
				target: { value: "active" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			const [, payload] = onDecide.mock.calls[0];
			expect(payload.todo.status).toBe("active");
			expect("completed_at" in payload.todo).toBe(false);
			expect("dropped_at" in payload.todo).toBe(false);
			// The partial's identity + ref lists still ride untouched.
			expect(payload.todo_id).toBe("todo-7");
			expect(payload.set_person_refs).toEqual([
				{ person_id: "dave-1", role: "related" },
			]);
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
				screen.getByRole("button", { name: /keep current person/i }),
			).toBeInTheDocument();
		});

		it("renders Current + Proposed sections so a note dropped from the full-replace payload is visible", () => {
			const updatePersonDropsNote: PendingProposal = {
				...updatePerson,
				payload: {
					entity_id: "person-7",
					name: "Alice Carter",
					// note + aliases OMITTED from the full-document replace — ADR-0016/0033:
					// an omitted field is a removal, which must be visible before accept.
				},
				review_context: {
					current_person: {
						entity_id: "person-7",
						name: "Alice Carter",
						note: "Now leads the daycare committee.",
						aliases: ["Ali", "AC"],
					},
				},
			};
			render(
				<ProposalCard proposal={updatePersonDropsNote} onDecide={() => {}} />,
			);
			// Both sections present: the current baseline and the proposed replacement.
			expect(screen.getByText("Current")).toBeInTheDocument();
			expect(screen.getByText("Replacing with")).toBeInTheDocument();
			// The dropped note (and aliases) survive only in the Current section — they
			// are gone from the proposed payload, so seeing them proves the removal.
			expect(
				screen.getByText("Now leads the daycare committee."),
			).toBeInTheDocument();
			expect(screen.getByText("Ali, AC")).toBeInTheDocument();
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
			// Status renders as its humanized label, not the raw enum.
			expect(screen.getByText("Active")).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /update project/i }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /^edit$/i }),
			).toBeInTheDocument();
		});

		it("renders Current + Proposed sections so an outcome dropped from the full-replace payload is visible", () => {
			const updateProjectDropsOutcome: PendingProposal = {
				...updateProject,
				payload: {
					entity_id: "project-7",
					name: "Ship API v2",
					status: "active",
					// outcome OMITTED from the full-document replace — must stay visible.
				},
				review_context: {
					current_project: {
						entity_id: "project-7",
						name: "Ship API v2",
						outcome: "All clients on v2 by Q3.",
						status: "active",
					},
				},
			};
			render(
				<ProposalCard
					proposal={updateProjectDropsOutcome}
					onDecide={() => {}}
				/>,
			);
			expect(screen.getByText("Current")).toBeInTheDocument();
			expect(screen.getByText("Replacing with")).toBeInTheDocument();
			// The dropped outcome survives only in the Current section.
			expect(screen.getByText("All clients on v2 by Q3.")).toBeInTheDocument();
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

	describe("record_observations", () => {
		const recordObservations: PendingProposal = {
			proposal_id: "prop-observations",
			run_id: "run-observations",
			mutation_kind: "record_observations",
			payload: {
				observations: [
					{
						schema_key: "bodyweight",
						occurred_at: "2026-06-02T07:30:00",
						values: { kg: 72.4 },
						note: "after breakfast",
					},
					{
						schema_key: "habit.checkin",
						occurred_at: "2026-06-03T07:30:00",
						values: {
							habit_id: "0190d3c1-0000-7000-8000-000000000004",
							state: "done",
						},
					},
				],
				evidence: {
					journal_entry_id: "0190d3c1-0000-7000-8000-000000000001",
				},
			},
			rationale: "capture tracker facts",
			status: "pending",
		};

		it("renders an Observation proposal without falling back to Journal Entry copy", () => {
			render(
				<ProposalCard proposal={recordObservations} onDecide={() => {}} />,
			);
			expect(
				screen.getByText("Inkstone wants to record Observations."),
			).toBeInTheDocument();
			expect(screen.getByText("2 observations")).toBeInTheDocument();
			expect(screen.getByText("1. bodyweight")).toBeInTheDocument();
			expect(screen.getByText("2026-06-02T07:30:00")).toBeInTheDocument();
			expect(screen.getByText('{"kg":72.4}')).toBeInTheDocument();
			expect(screen.getByText("after breakfast")).toBeInTheDocument();
			expect(
				screen.getByText("Journal Entry: 0190d3c1-0000-7000-8000-000000000001"),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /record observations/i }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /^edit$/i }),
			).toBeInTheDocument();
		});

		it("saves a whole-payload edit as record_observations edited_payload", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard proposal={recordObservations} onDecide={onDecide} />,
			);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /payload/i }), {
				target: {
					value: JSON.stringify({
						observations: [
							{
								schema_key: "bodyweight",
								occurred_at: "2026-06-04T07:30:00",
								values: { kg: 72.2 },
								note: "corrected scale reading",
							},
						],
					}),
				},
			});
			fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
			expect(onDecide).toHaveBeenCalledWith("edit", {
				observations: [
					{
						schema_key: "bodyweight",
						occurred_at: "2026-06-04T07:30:00",
						values: { kg: 72.2 },
						note: "corrected scale reading",
					},
				],
			});
		});

		it("blocks a record_observations edit that fails the shared payload schema", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard proposal={recordObservations} onDecide={onDecide} />,
			);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /payload/i }), {
				target: { value: JSON.stringify({ observations: [] }) },
			});

			expect(screen.getByRole("alert")).toHaveTextContent(
				"payload must match the record_observations schema",
			);
			expect(
				screen.getByRole("button", { name: /save changes/i }),
			).toBeDisabled();
			expect(onDecide).not.toHaveBeenCalled();
		});

		it("blocks a record_observations edit with fields Core would reject", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard proposal={recordObservations} onDecide={onDecide} />,
			);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /payload/i }), {
				target: {
					value: JSON.stringify({
						observations: [
							{
								schema_key: "bodyweight",
								occurred_at: "2026-06-04T07:30:00",
								values: { kg: 72.2 },
								unit: "kg",
							},
						],
					}),
				},
			});

			expect(screen.getByRole("alert")).toHaveTextContent(
				"payload must match the record_observations schema",
			);
			expect(
				screen.getByRole("button", { name: /save changes/i }),
			).toBeDisabled();
			expect(onDecide).not.toHaveBeenCalled();
		});

		it("blocks a record_observations edit with reversed times", () => {
			const onDecide = vi.fn();
			render(
				<ProposalCard proposal={recordObservations} onDecide={onDecide} />,
			);
			fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
			fireEvent.change(screen.getByRole("textbox", { name: /payload/i }), {
				target: {
					value: JSON.stringify({
						observations: [
							{
								schema_key: "bodyweight",
								occurred_at: "2026-06-04T08:30:00",
								ended_at: "2026-06-04T07:30:00",
								values: { kg: 72.2 },
							},
						],
					}),
				},
			});

			expect(screen.getByRole("alert")).toHaveTextContent(
				"ended_at must be greater than or equal to occurred_at",
			);
			expect(
				screen.getByRole("button", { name: /save changes/i }),
			).toBeDisabled();
			expect(onDecide).not.toHaveBeenCalled();
		});

		it("renders Core's record_observations validation error", () => {
			render(
				<ProposalCard
					proposal={{
						...recordObservations,
						status: "error",
						error_message: "habit_id must reference an accepted Habit",
					}}
					onDecide={() => {}}
				/>,
			);

			expect(screen.getByRole("alert")).toHaveTextContent(
				"habit_id must reference an accepted Habit",
			);
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
			// Degrades without crashing: the heading + accept button still render even
			// when the ref fields are malformed (the raw todo_id is intentionally not shown).
			expect(
				screen.getByText("Inkstone wants to update a Todo."),
			).toBeInTheDocument();
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
			// fallbackView routes to renderNoBody: no detail-body section. "Body text"
			// still shows as the header summary (journalBody fallback), so pin the
			// EntrySection title — it renders ONLY inside a journal body, so a re-wire
			// to a journal strategy fails here instead of slipping through.
			expect(
				screen.queryByText(/Proposed entry|Current entry/),
			).not.toBeInTheDocument();
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
						mutation_kind: "create_widget",
						payload: null,
						rationale: null,
						status: "pending",
					}}
					onDecide={() => {}}
				/>,
			);
			expect(
				screen.getByText("Inkstone wants to create a create_widget."),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /add journal entry/i }),
			).toBeInTheDocument();
		});
	});

	// The apply_intent_graph sequential-review card (ADR-0042): a resolved plan
	// rendered as a node queue with a local staging buffer + one atomic commit.
	describe("intent graph review card", () => {
		const graphProposal: PendingProposal = {
			proposal_id: "graph-prop",
			run_id: "graph-run",
			mutation_kind: "apply_intent_graph",
			payload: {
				links: [{ kind: "todo_project", from: "@rodeo", to: "@leadads" }],
			},
			rationale: "recognized from your note",
			resolved_plan: [
				{
					handle: "@rodeo",
					type: "todo",
					disposition: "create",
					label: "Figure out the Rodeo side",
				},
				{
					handle: "@leadads",
					type: "project",
					disposition: "create",
					label: "Lead Ads",
				},
			],
			status: "pending",
		};

		it("renders one row per plan node with a create badge", () => {
			render(<ProposalCard proposal={graphProposal} onDecide={() => {}} />);
			expect(screen.getByText("Figure out the Rodeo side")).toBeInTheDocument();
			expect(screen.getByText("Lead Ads")).toBeInTheDocument();
			expect(screen.getAllByText("New")).toHaveLength(2);
			expect(screen.getByText(/2 items to review/i)).toBeInTheDocument();
		});

		it("commits an all-accept decisions vector on Apply", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={graphProposal} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /apply 2 items/i }));
			expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
				{ handle: "@rodeo", decision: "accept" },
				{ handle: "@leadads", decision: "accept" },
			]);
		});

		it("rejecting the project surfaces the Todo downgrade and drops the link in the vector", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={graphProposal} onDecide={onDecide} />);
			// Reject the project node (its row's Reject toggle).
			fireEvent.click(screen.getByRole("button", { name: /reject lead ads/i }));
			// The downgrade notice appears before Apply.
			expect(screen.getByText(/without its project link/i)).toBeInTheDocument();
			// Apply now carries the project as a reject; the Todo stays an accept.
			fireEvent.click(screen.getByRole("button", { name: /apply 1 item/i }));
			expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
				{ handle: "@rodeo", decision: "accept" },
				{ handle: "@leadads", decision: "reject" },
			]);
		});

		it("Dismiss all commits a reject", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={graphProposal} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /dismiss all/i }));
			expect(onDecide).toHaveBeenCalledWith("reject", undefined, [
				{ handle: "@rodeo", decision: "reject" },
				{ handle: "@leadads", decision: "reject" },
			]);
		});

		it("an ambiguous node cannot be accepted (reject-only, #181)", () => {
			const onDecide = vi.fn();
			const withAmbiguous: PendingProposal = {
				...graphProposal,
				payload: { links: [] },
				resolved_plan: [
					{
						handle: "@morris",
						type: "person",
						disposition: "ambiguous",
						label: "Morris",
						candidates: [
							{ entity_id: "m1", label: "Morris" },
							{ entity_id: "m2", label: "Morris" },
						],
					},
				],
			};
			render(<ProposalCard proposal={withAmbiguous} onDecide={onDecide} />);
			// The accept toggle for the ambiguous node is disabled UNTIL a candidate
			// is picked.
			expect(
				screen.getByRole("button", { name: /accept morris/i }),
			).toBeDisabled();
			expect(
				screen.getByText(/match more than one existing entry/i),
			).toBeInTheDocument();
			// The whole plan is the ambiguous node (default reject) → "Dismiss all"
			// commits a reject-all (Core declines the graph).
			fireEvent.click(screen.getByRole("button", { name: /dismiss all/i }));
			expect(onDecide).toHaveBeenCalledWith("reject", undefined, [
				{ handle: "@morris", decision: "reject" },
			]);
		});

		// The disambiguation picker (#181): an ambiguous node renders its candidates
		// as an inline radio list; picking one collapses the node ambiguous → reuse.
		describe("ambiguous candidate picker", () => {
			// These tests seed the process-shared, module-level `libraryItems.current`
			// (via seedTwoMorris / the fallback []); restore it after each so the m1/m2
			// cache can't leak into sibling tests regardless of run order.
			afterEach(() => {
				libraryItems.current = [];
			});

			const ambiguousProposal: PendingProposal = {
				...graphProposal,
				payload: { links: [] },
				resolved_plan: [
					{
						handle: "@morris",
						type: "person",
						disposition: "ambiguous",
						label: "Morris",
						candidates: [
							{ entity_id: "m1", label: "Morris" },
							{ entity_id: "m2", label: "Morris" },
						],
					},
				],
			};

			// Two same-named People distinguished only by their note — the subtitle is
			// the disambiguator (the candidate labels are identical exact-name matches).
			const seedTwoMorris = () => {
				libraryItems.current = [
					{
						id: "m1",
						kind: "person",
						name: "Morris",
						note: "from the Rodeo sync",
					} as LibraryItem,
					{
						id: "m2",
						kind: "person",
						name: "Morris",
						note: "the Lead Ads contact",
					} as LibraryItem,
				];
			};

			it("renders a radio per candidate with an enriched disambiguating subtitle", () => {
				seedTwoMorris();
				render(
					<ProposalCard proposal={ambiguousProposal} onDecide={() => {}} />,
				);
				const radios = screen.getAllByRole<HTMLInputElement>("radio");
				expect(radios).toHaveLength(2);
				// None is pre-selected — an explicit pick is forced (equal exact matches).
				expect(radios.every((r) => !r.checked)).toBe(true);
				// The subtitle (libraryItemSubtitle → person note) distinguishes the rows.
				expect(screen.getByText(/from the Rodeo sync/i)).toBeInTheDocument();
				expect(screen.getByText(/the Lead Ads contact/i)).toBeInTheDocument();
			});

			it("keeps accept disabled until a candidate is picked, then enables it", () => {
				seedTwoMorris();
				render(
					<ProposalCard proposal={ambiguousProposal} onDecide={() => {}} />,
				);
				expect(
					screen.getByRole("button", { name: /accept morris/i }),
				).toBeDisabled();
				// Pick the first candidate.
				fireEvent.click(screen.getAllByRole("radio")[0]);
				expect(
					screen.getByRole("button", { name: /accept morris/i }),
				).toBeEnabled();
				// The badge flips from "Needs disambiguation" to a reuse "Existing «…»".
				expect(
					screen.queryByText("Needs disambiguation"),
				).not.toBeInTheDocument();
				expect(screen.getByText(/Existing «Morris»/)).toBeInTheDocument();
			});

			it("Apply submits the picked candidate's entity_id as an accept", () => {
				seedTwoMorris();
				const onDecide = vi.fn();
				render(
					<ProposalCard proposal={ambiguousProposal} onDecide={onDecide} />,
				);
				// Pick the SECOND Morris, then Apply.
				fireEvent.click(screen.getAllByRole("radio")[1]);
				fireEvent.click(screen.getByRole("button", { name: /apply 1 item/i }));
				expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
					{ handle: "@morris", decision: "accept", entity_id: "m2" },
				]);
			});

			it("re-picking switches the chosen candidate", () => {
				seedTwoMorris();
				const onDecide = vi.fn();
				render(
					<ProposalCard proposal={ambiguousProposal} onDecide={onDecide} />,
				);
				fireEvent.click(screen.getAllByRole("radio")[0]);
				fireEvent.click(screen.getAllByRole("radio")[1]);
				fireEvent.click(screen.getByRole("button", { name: /apply 1 item/i }));
				expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
					{ handle: "@morris", decision: "accept", entity_id: "m2" },
				]);
			});

			it("picking after an explicit reject re-accepts the node (forces accept)", () => {
				seedTwoMorris();
				const onDecide = vi.fn();
				render(
					<ProposalCard proposal={ambiguousProposal} onDecide={onDecide} />,
				);
				// Reject the node explicitly, THEN pick a candidate — the pick must
				// override the stale `reject` in the buffer (not just set the repoint).
				fireEvent.click(screen.getByRole("button", { name: /reject morris/i }));
				fireEvent.click(screen.getAllByRole("radio")[0]);
				fireEvent.click(screen.getByRole("button", { name: /apply 1 item/i }));
				expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
					{ handle: "@morris", decision: "accept", entity_id: "m1" },
				]);
			});

			it("a pending (unpicked) ambiguous node's Reject toggle reads un-pressed", () => {
				seedTwoMorris();
				render(
					<ProposalCard proposal={ambiguousProposal} onDecide={() => {}} />,
				);
				// The node sits at the reject DEFAULT but is awaiting a pick — its Reject
				// toggle must not look pre-engaged (it reads pending, not dismissed).
				expect(
					screen.getByRole("button", { name: /reject morris/i }),
				).toHaveAttribute("aria-pressed", "false");
				// After an explicit reject it IS pressed.
				fireEvent.click(screen.getByRole("button", { name: /reject morris/i }));
				expect(
					screen.getByRole("button", { name: /reject morris/i }),
				).toHaveAttribute("aria-pressed", "true");
			});

			it("the dynamic note disappears once the ambiguous node is PICKED", () => {
				seedTwoMorris();
				render(
					<ProposalCard proposal={ambiguousProposal} onDecide={() => {}} />,
				);
				expect(
					screen.getByText(/match more than one existing entry/i),
				).toBeInTheDocument();
				// Once picked, the guidance note disappears (the node is resolved).
				fireEvent.click(screen.getAllByRole("radio")[0]);
				expect(
					screen.queryByText(/match more than one existing entry/i),
				).not.toBeInTheDocument();
			});

			it("the dynamic note disappears once the ambiguous node is explicitly REJECTED", () => {
				// The other way `unresolvedAmbiguous` goes false: an explicit reject of the
				// sole ambiguous node resolves it (decline), so the "pick or reject" nag must
				// also clear — not just on a pick.
				seedTwoMorris();
				render(
					<ProposalCard proposal={ambiguousProposal} onDecide={() => {}} />,
				);
				expect(
					screen.getByText(/match more than one existing entry/i),
				).toBeInTheDocument();
				fireEvent.click(screen.getByRole("button", { name: /reject morris/i }));
				expect(
					screen.queryByText(/match more than one existing entry/i),
				).not.toBeInTheDocument();
			});

			it("falls back to the label when a candidate is not in the library cache", () => {
				libraryItems.current = []; // no enrichment available
				render(
					<ProposalCard proposal={ambiguousProposal} onDecide={() => {}} />,
				);
				// Both candidate rows still render (by their label), pickable.
				expect(screen.getAllByRole("radio")).toHaveLength(2);
				fireEvent.click(screen.getAllByRole("radio")[0]);
				expect(
					screen.getByRole("button", { name: /accept morris/i }),
				).toBeEnabled();
			});
		});

		it("renders the Existing badge for a reuse-disposition node", () => {
			const withReuse: PendingProposal = {
				...graphProposal,
				payload: { links: [] },
				resolved_plan: [
					{
						handle: "@leadads",
						type: "project",
						disposition: "reuse",
						label: "Lead Ads",
						entity_id: "p1",
					},
				],
			};
			render(<ProposalCard proposal={withReuse} onDecide={() => {}} />);
			expect(screen.getByText("Lead Ads")).toBeInTheDocument();
			expect(screen.getByText("Existing")).toBeInTheDocument();
		});

		// The node-row disposition pill routes through the Badge primitive (not a
		// hand-rolled span): a create/reuse node wears the `secondary` variant — which
		// carries the hairline border the primitive adds for low-contrast surfaces.
		it("a create-disposition pill wears the secondary Badge hairline border", () => {
			render(<ProposalCard proposal={graphProposal} onDecide={() => {}} />);
			const pill = screen.getAllByText("New")[0].closest("span");
			expect(pill).not.toBeNull();
			expect(pill?.className).toContain("border-secondary-foreground/25");
			expect(pill?.className).toContain("text-[0.6875rem]");
		});

		// An ambiguous node wears the `destructive` variant — the primitive's
		// `destructive/12` fill (not the fork's diverged `destructive/10`).
		it("an ambiguous-disposition pill wears the destructive Badge variant", () => {
			const withAmbiguous: PendingProposal = {
				...graphProposal,
				payload: { links: [] },
				resolved_plan: [
					{
						handle: "@morris",
						type: "person",
						disposition: "ambiguous",
						label: "Morris",
						candidates: [
							{ entity_id: "m1", label: "Morris" },
							{ entity_id: "m2", label: "Morris" },
						],
					},
				],
			};
			render(<ProposalCard proposal={withAmbiguous} onDecide={() => {}} />);
			const pill = screen.getByText("Needs disambiguation").closest("span");
			expect(pill).not.toBeNull();
			expect(pill?.className).toContain("bg-destructive/12");
			expect(pill?.className).toContain("text-destructive");
		});

		// Near-match default-to-existing (ADR-0042 amendment): a create node carrying
		// a single near_match defaults to reusing that existing entity.
		describe("near-match default-to-existing", () => {
			const withNearMatch: PendingProposal = {
				...graphProposal,
				payload: { links: [] },
				resolved_plan: [
					{
						handle: "@leadads",
						type: "project",
						disposition: "create",
						label: "Lead Ads testing",
						near_matches: [
							{ entity_id: "existing-leadads", label: "Lead Ads" },
						],
					},
				],
			};

			it("badges a single-near-match node 'Existing «…»' and defaults Apply to the existing entity_id", () => {
				const onDecide = vi.fn();
				const { container } = render(
					<ProposalCard proposal={withNearMatch} onDecide={onDecide} />,
				);
				// The node keeps its proposed label, but the badge points at the existing.
				expect(screen.getByText("Lead Ads testing")).toBeInTheDocument();
				expect(screen.getByText("Existing «Lead Ads»")).toBeInTheDocument();
				expect(
					container.querySelector('[data-graph-node="@leadads"]'),
				).toHaveAttribute("data-node-repoint", "existing-leadads");
				// A blind Apply re-points onto the existing project (no duplicate minted).
				fireEvent.click(screen.getByRole("button", { name: /apply 1 item/i }));
				expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
					{
						handle: "@leadads",
						decision: "accept",
						entity_id: "existing-leadads",
					},
				]);
			});

			it("'Create new instead' clears the re-point so Apply mints a new entity", () => {
				const onDecide = vi.fn();
				const { container } = render(
					<ProposalCard proposal={withNearMatch} onDecide={onDecide} />,
				);
				fireEvent.click(
					screen.getByRole("button", { name: /create new instead/i }),
				);
				// The badge reverts to "New" and the re-point attribute is gone.
				expect(screen.getByText("New")).toBeInTheDocument();
				expect(
					container.querySelector('[data-graph-node="@leadads"]'),
				).not.toHaveAttribute("data-node-repoint");
				fireEvent.click(screen.getByRole("button", { name: /apply 1 item/i }));
				expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
					{ handle: "@leadads", decision: "accept" },
				]);
			});

			it("'Use existing' re-points back after 'Create new instead' (badge + entity_id restored)", () => {
				const onDecide = vi.fn();
				const { container } = render(
					<ProposalCard proposal={withNearMatch} onDecide={onDecide} />,
				);
				// Opt out, then opt back in via the "Use existing «…»" affordance.
				fireEvent.click(
					screen.getByRole("button", { name: /create new instead/i }),
				);
				expect(
					container.querySelector('[data-graph-node="@leadads"]'),
				).not.toHaveAttribute("data-node-repoint");
				fireEvent.click(
					screen.getByRole("button", { name: /use existing «Lead Ads»/i }),
				);
				// The re-point is restored: badge + attribute back, and Apply re-emits entity_id.
				expect(screen.getByText("Existing «Lead Ads»")).toBeInTheDocument();
				expect(
					container.querySelector('[data-graph-node="@leadads"]'),
				).toHaveAttribute("data-node-repoint", "existing-leadads");
				fireEvent.click(screen.getByRole("button", { name: /apply 1 item/i }));
				expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
					{
						handle: "@leadads",
						decision: "accept",
						entity_id: "existing-leadads",
					},
				]);
			});

			it("surfaces 2+ near-matches advisorily without auto-picking", () => {
				const onDecide = vi.fn();
				const multi: PendingProposal = {
					...graphProposal,
					payload: { links: [] },
					resolved_plan: [
						{
							handle: "@leadads",
							type: "project",
							disposition: "create",
							label: "Lead Ads testing",
							near_matches: [
								{ entity_id: "la1", label: "Lead Ads" },
								{ entity_id: "la2", label: "Lead Ads work" },
							],
						},
					],
				};
				const { container } = render(
					<ProposalCard proposal={multi} onDecide={onDecide} />,
				);
				// Still "New" (no auto-pick), but the matches are surfaced.
				expect(screen.getByText("New")).toBeInTheDocument();
				expect(
					container.querySelector('[data-graph-node="@leadads"]'),
				).not.toHaveAttribute("data-node-repoint");
				expect(screen.getByText(/matches existing/i)).toBeInTheDocument();
				fireEvent.click(screen.getByRole("button", { name: /apply 1 item/i }));
				expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
					{ handle: "@leadads", decision: "accept" },
				]);
			});
		});

		it("renders TWO downgrade notices (no key collision) when one Todo loses both links", () => {
			const onDecide = vi.fn();
			const bothLinks: PendingProposal = {
				...graphProposal,
				payload: {
					links: [
						{ kind: "todo_project", from: "@rodeo", to: "@leadads" },
						{ kind: "todo_person", from: "@rodeo", to: "@morris" },
					],
				},
				resolved_plan: [
					{
						handle: "@rodeo",
						type: "todo",
						disposition: "create",
						label: "Rodeo task",
					},
					{
						handle: "@leadads",
						type: "project",
						disposition: "create",
						label: "Lead Ads",
					},
					{
						handle: "@morris",
						type: "person",
						disposition: "create",
						label: "Morris",
					},
				],
			};
			render(<ProposalCard proposal={bothLinks} onDecide={onDecide} />);
			// Reject BOTH the project and the person, keeping the Todo accepted.
			fireEvent.click(screen.getByRole("button", { name: /reject lead ads/i }));
			fireEvent.click(screen.getByRole("button", { name: /reject morris/i }));
			// Both distinct downgrade notices render (the project-link and person-link
			// copy differ) — the key fix means the second is not dropped.
			expect(
				screen.getByText(/without its project link to .Lead Ads./i),
			).toBeInTheDocument();
			expect(
				screen.getByText(/without its link to .Morris./i),
			).toBeInTheDocument();
		});

		// Per-node inline edit of a create node (ADR-0042 edited_fields). The card
		// reads each node's proposed fields off payload.entities to seed the form.
		const editableGraph: PendingProposal = {
			proposal_id: "graph-edit",
			run_id: "graph-edit-run",
			mutation_kind: "apply_intent_graph",
			payload: {
				entities: [
					{
						handle: "@rodeo",
						type: "todo",
						title: "Figure out the Rodeo side",
					},
					{
						handle: "@leadads",
						type: "project",
						name: "Lead Ads",
						note: "guessed",
					},
				],
				links: [{ kind: "todo_project", from: "@rodeo", to: "@leadads" }],
			},
			rationale: null,
			resolved_plan: [
				{
					handle: "@rodeo",
					type: "todo",
					disposition: "create",
					label: "Figure out the Rodeo side",
				},
				{
					handle: "@leadads",
					type: "project",
					disposition: "create",
					label: "Lead Ads",
				},
			],
			status: "pending",
		};

		it("edits a create node's title and sends edited_fields on Apply", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={editableGraph} onDecide={onDecide} />);
			// Open the Todo's inline edit form.
			fireEvent.click(
				screen.getByRole("button", { name: /edit figure out the rodeo side/i }),
			);
			const title = screen.getByLabelText("Title");
			fireEvent.change(title, {
				target: { value: "Sort out the Rodeo logistics" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save/i }));
			// The collapsed row now reflects the edited title and is badged "Edited".
			expect(
				screen.getByText("Sort out the Rodeo logistics"),
			).toBeInTheDocument();
			expect(screen.getByText("Edited")).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: /apply 2 items/i }));
			expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
				{
					handle: "@rodeo",
					decision: "accept",
					edited_fields: { title: "Sort out the Rodeo logistics" },
				},
				{ handle: "@leadads", decision: "accept" },
			]);
		});

		it("clears a proposed optional with a null edited field", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={editableGraph} onDecide={onDecide} />);
			fireEvent.click(screen.getByRole("button", { name: /edit lead ads/i }));
			// The project proposed note:"guessed"; blank it.
			fireEvent.change(screen.getByLabelText("Note"), {
				target: { value: "" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save/i }));
			fireEvent.click(screen.getByRole("button", { name: /apply 2 items/i }));
			expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
				{ handle: "@rodeo", decision: "accept" },
				{
					handle: "@leadads",
					decision: "accept",
					edited_fields: { note: null },
				},
			]);
		});

		it("opening an edit form and leaving it unchanged commits a plain accept", () => {
			const onDecide = vi.fn();
			const { container } = render(
				<ProposalCard proposal={editableGraph} onDecide={onDecide} />,
			);
			fireEvent.click(
				screen.getByRole("button", { name: /edit figure out the rodeo side/i }),
			);
			fireEvent.click(screen.getByRole("button", { name: /save/i }));
			// An unchanged save sends no correction, so the badge still reads "New" —
			// the disposition slot must not claim "Edited" when nothing will change.
			const row = container.querySelector('[data-graph-node="@rodeo"]');
			expect(row?.getAttribute("data-node-edited")).toBeNull();
			fireEvent.click(screen.getByRole("button", { name: /apply 2 items/i }));
			expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
				{ handle: "@rodeo", decision: "accept" },
				{ handle: "@leadads", decision: "accept" },
			]);
		});

		it("disables Save when the required field is blanked", () => {
			render(<ProposalCard proposal={editableGraph} onDecide={() => {}} />);
			fireEvent.click(
				screen.getByRole("button", { name: /edit figure out the rodeo side/i }),
			);
			fireEvent.change(screen.getByLabelText("Title"), {
				target: { value: "" },
			});
			expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
		});

		it("Cancel discards in-progress edits (no edited_fields on Apply)", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={editableGraph} onDecide={onDecide} />);
			fireEvent.click(
				screen.getByRole("button", { name: /edit figure out the rodeo side/i }),
			);
			fireEvent.change(screen.getByLabelText("Title"), {
				target: { value: "Discarded rename" },
			});
			fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
			// The row reverts to the original label; the edit never reaches the wire.
			expect(screen.getByText("Figure out the Rodeo side")).toBeInTheDocument();
			expect(screen.queryByText("Discarded rename")).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: /apply 2 items/i }));
			expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
				{ handle: "@rodeo", decision: "accept" },
				{ handle: "@leadads", decision: "accept" },
			]);
		});

		it("rejecting an edited node drops its edit from the vector", () => {
			const onDecide = vi.fn();
			render(<ProposalCard proposal={editableGraph} onDecide={onDecide} />);
			// Edit the Todo, then reject it.
			fireEvent.click(
				screen.getByRole("button", { name: /edit figure out the rodeo side/i }),
			);
			fireEvent.change(screen.getByLabelText("Title"), {
				target: { value: "Renamed" },
			});
			fireEvent.click(screen.getByRole("button", { name: /save/i }));
			// Accepted-and-edited, the row is badged "Edited"...
			expect(screen.getByText("Edited")).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: /reject renamed/i }));
			// ...but rejecting it drops the edit, so the badge must NOT claim "Edited"
			// (a rejected node commits a plain reject — no edited_fields).
			expect(screen.queryByText("Edited")).not.toBeInTheDocument();
			// One node accepted (the project); the rejected Todo carries no edit.
			fireEvent.click(screen.getByRole("button", { name: /apply 1 item/i }));
			expect(onDecide).toHaveBeenCalledWith("accept", undefined, [
				{ handle: "@rodeo", decision: "reject" },
				{ handle: "@leadads", decision: "accept" },
			]);
		});

		it("does not offer an edit affordance on a reuse node", () => {
			const withReuse: PendingProposal = {
				...editableGraph,
				payload: { entities: [], links: [] },
				resolved_plan: [
					{
						handle: "@leadads",
						type: "project",
						disposition: "reuse",
						label: "Lead Ads",
						entity_id: "p1",
					},
				],
			};
			render(<ProposalCard proposal={withReuse} onDecide={() => {}} />);
			expect(
				screen.queryByRole("button", { name: /edit lead ads/i }),
			).not.toBeInTheDocument();
		});

		it("resets staging when a new proposal_id renders in the same card (no leak across graphs)", () => {
			const onDecide = vi.fn();
			// Graph #1: reject the Rodeo node (handle @rodeo).
			const { rerender } = render(
				<ProposalCard proposal={graphProposal} onDecide={onDecide} />,
			);
			fireEvent.click(
				screen.getByRole("button", {
					name: /reject figure out the rodeo side/i,
				}),
			);
			// Graph #2 arrives on the SAME run_id (same mounted card) with a fresh
			// proposal_id and an UNRELATED node that happens to reuse the handle @rodeo.
			const nextGraph: PendingProposal = {
				...graphProposal,
				proposal_id: "graph-prop-2",
				payload: { links: [] },
				resolved_plan: [
					{
						handle: "@rodeo",
						type: "person",
						disposition: "create",
						label: "Rodrigo",
					},
				],
			};
			rerender(<ProposalCard proposal={nextGraph} onDecide={onDecide} />);
			// The prior reject must NOT leak: committing accepts the new @rodeo node.
			fireEvent.click(screen.getByRole("button", { name: /apply 1 item/i }));
			expect(onDecide).toHaveBeenLastCalledWith("accept", undefined, [
				{ handle: "@rodeo", decision: "accept" },
			]);
		});
	});

	// The decided card names what changed and links to it in the Library (ADR-0044
	// entity_id amendment): an accepted Proposal whose `entity_id` resolves in the
	// warm library cache shows the entity's current title + a "View in Library"
	// deep-link; anything unresolvable degrades to the generic decided copy.
	describe("decided card names the entity and links to the Library", () => {
		const priya: LibraryItem = {
			id: "person_priya",
			kind: "person",
			name: "Priya Nair",
			createdAt: "Today, 10:42",
			recency: 95,
		};

		afterEach(() => {
			navigate.mockReset();
			libraryItems.current = [];
		});

		it("shows the entity title and a View-in-Library deep-link when accepted and resolvable", () => {
			libraryItems.current = [priya];
			render(
				<ProposalCard
					proposal={{
						...base,
						mutation_kind: "create_person",
						status: "accepted",
						entity_id: "person_priya",
					}}
					onDecide={() => {}}
				/>,
			);
			expect(screen.getByText("Priya Nair")).toBeInTheDocument();
			const link = screen.getByRole("button", { name: /view in library/i });
			fireEvent.click(link);
			expect(navigate).toHaveBeenCalledWith({
				to: "/library/$kind",
				params: { kind: "people" },
				search: { id: "person_priya" },
			});
		});

		it("degrades to the generic accepted copy with no link when the entity_id is unresolvable", () => {
			// entity_id present but absent from the warm cache (still loading / Core
			// unreachable / since-deleted) → never worse than the generic decided card.
			libraryItems.current = [];
			render(
				<ProposalCard
					proposal={{
						...base,
						mutation_kind: "create_person",
						status: "accepted",
						entity_id: "person_ghost",
					}}
					onDecide={() => {}}
				/>,
			);
			expect(screen.getByText(/added person/i)).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /view in library/i }),
			).not.toBeInTheDocument();
			expect(screen.queryByText("Priya Nair")).not.toBeInTheDocument();
		});

		it("links an accepted intent-graph card to its anchor entity", () => {
			libraryItems.current = [priya];
			render(
				<ProposalCard
					proposal={{
						proposal_id: "graph-prop",
						run_id: "graph-run",
						mutation_kind: "apply_intent_graph",
						payload: null,
						rationale: null,
						status: "accepted",
						entity_id: "person_priya",
					}}
					onDecide={() => {}}
				/>,
			);
			const link = screen.getByRole("button", { name: /view in library/i });
			fireEvent.click(link);
			expect(navigate).toHaveBeenCalledWith({
				to: "/library/$kind",
				params: { kind: "people" },
				search: { id: "person_priya" },
			});
		});
	});

	// Rejecting an UPDATE proposal must reassure that the current entity was kept,
	// not leave a bare "Dismissed." that reads as if the entity were discarded. CREATE
	// kinds keep "Dismissed." — nothing existed to keep.
	describe("update-reject copy reassures the current entity was kept", () => {
		const updateTodo: PendingProposal = {
			proposal_id: "prop-reject-update-todo",
			run_id: "run-reject-update-todo",
			mutation_kind: "update_todo",
			payload: { todo_id: "todo-7", todo: { title: "Email Alice" } },
			rationale: null,
			status: "pending",
		};
		const updatePerson: PendingProposal = {
			proposal_id: "prop-reject-update-person",
			run_id: "run-reject-update-person",
			mutation_kind: "update_person",
			payload: { entity_id: "person-7", name: "Alice Carter" },
			rationale: null,
			status: "pending",
		};
		const updateProject: PendingProposal = {
			proposal_id: "prop-reject-update-project",
			run_id: "run-reject-update-project",
			mutation_kind: "update_project",
			payload: { entity_id: "project-7", name: "Ship API v2" },
			rationale: null,
			status: "pending",
		};

		it("update_todo rejected reads 'Kept current Todo.'", () => {
			render(
				<ProposalCard
					proposal={{ ...updateTodo, status: "rejected" }}
					onDecide={() => {}}
				/>,
			);
			expect(screen.getByText("Kept current Todo.")).toBeInTheDocument();
		});

		it("update_person rejected reads 'Kept current Person.'", () => {
			render(
				<ProposalCard
					proposal={{ ...updatePerson, status: "rejected" }}
					onDecide={() => {}}
				/>,
			);
			expect(screen.getByText("Kept current Person.")).toBeInTheDocument();
		});

		it("update_project rejected reads 'Kept current Project.'", () => {
			render(
				<ProposalCard
					proposal={{ ...updateProject, status: "rejected" }}
					onDecide={() => {}}
				/>,
			);
			expect(screen.getByText("Kept current Project.")).toBeInTheDocument();
		});

		// Regression guard: a CREATE created nothing, so its reject stays "Dismissed."
		// — flipping a create to reassurance copy must fail here.
		it("create_person rejected still reads 'Dismissed.'", () => {
			render(
				<ProposalCard
					proposal={{
						...base,
						mutation_kind: "create_person",
						payload: { name: "Alice Carter" },
						status: "rejected",
					}}
					onDecide={() => {}}
				/>,
			);
			expect(screen.getByText("Dismissed.")).toBeInTheDocument();
		});

		// The pending reject button must offer the reassuring "Keep current …" verb,
		// not a bare "Dismiss".
		it("update_todo pending offers a 'Keep current Todo' reject button", () => {
			render(<ProposalCard proposal={updateTodo} onDecide={() => {}} />);
			expect(
				screen.getByRole("button", { name: /keep current todo/i }),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /^dismiss$/i }),
			).not.toBeInTheDocument();
		});
	});
});

// The edit-affordance fork routes GTD kinds to GtdEditForm, journal create/update
// to the journal form, and observation batches to their payload editor. Everything
// else is read-only. This structural lock catches an editable kind with no editor.
describe("proposal edit fork partition", () => {
	const JOURNAL_EDIT_KINDS = new Set([
		"create_journal_entry",
		"update_journal_entry",
	]);
	const STRUCTURED_EDIT_KINDS = new Set(["record_observations"]);

	it("every GTD-editable kind is also Edit-offered (canEdit and isGtdEditKind agree)", () => {
		for (const [kind, view] of Object.entries(PROPOSAL_VIEWS)) {
			if (isGtdEditKind(kind)) {
				// A GTD kind ignores bodyHasEntityRef and is always editable.
				expect(view.canEdit(false)).toBe(true);
				expect(view.canEdit(true)).toBe(true);
			}
		}
	});

	it("every editable kind routes to GtdEditForm or the journal form — none falls through", () => {
		for (const [kind, view] of Object.entries(PROPOSAL_VIEWS)) {
			const editable = view.canEdit(false) || view.canEdit(true);
			if (!editable) continue;
			expect(
				isGtdEditKind(kind) ||
					JOURNAL_EDIT_KINDS.has(kind) ||
					STRUCTURED_EDIT_KINDS.has(kind),
			).toBe(true);
		}
	});
});
