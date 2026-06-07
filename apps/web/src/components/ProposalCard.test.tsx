import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingProposal } from "@/store/chat";
import { ProposalCard } from "./ProposalCard.js";

const base: PendingProposal = {
	proposal_id: "prop-1",
	run_id: "run-1",
	kind: "todo",
	change_kind: "create",
	data: { title: "buy milk", done: false },
	rationale: "the user asked to remember this",
	status: "pending",
};

describe("ProposalCard", () => {
	afterEach(cleanup);

	it("renders the pending proposal with its title, rationale, and the three actions", () => {
		render(<ProposalCard proposal={base} onDecide={() => {}} />);
		expect(screen.getAllByText("buy milk").length).toBeGreaterThan(0);
		expect(
			screen.getByText("the user asked to remember this"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /add to todos/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /dismiss/i }),
		).toBeInTheDocument();
	});

	it("calls onDecide('accept') when Add to Todos is clicked", () => {
		const onDecide = vi.fn();
		render(<ProposalCard proposal={base} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: /add to todos/i }));
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
		expect(screen.getByRole("button", { name: /add to todos/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /dismiss/i })).toBeDisabled();
	});

	it("shows a progress affordance on the chosen action while deciding (m1)", () => {
		// Render pending, click Add to Todos, then re-render as deciding: the
		// spinner/progress label lands on the chosen (accept) action, while the
		// others stay disabled with their resting labels.
		const onDecide = vi.fn();
		const { rerender } = render(
			<ProposalCard proposal={base} onDecide={onDecide} />,
		);
		fireEvent.click(screen.getByRole("button", { name: /add to todos/i }));
		rerender(
			<ProposalCard
				proposal={{ ...base, status: "deciding" }}
				onDecide={onDecide}
			/>,
		);
		const accept = screen.getByRole("button", { name: /adding/i });
		expect(accept).toBeDisabled();
		expect(accept).toHaveTextContent(/adding/i);
		// The unchosen action keeps its resting label and stays disabled.
		expect(screen.getByRole("button", { name: /dismiss/i })).toBeDisabled();
	});

	it("collapses to the accepted state", () => {
		render(
			<ProposalCard
				proposal={{ ...base, status: "accepted" }}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByText(/added to todos/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /add to todos/i }),
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
		expect(
			screen.queryByRole("button", { name: /add to todos/i }),
		).not.toBeInTheDocument();
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
});
