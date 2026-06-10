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
});
