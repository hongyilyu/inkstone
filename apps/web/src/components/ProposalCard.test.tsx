import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { proposals } from "../data/mock.js";
import { ProposalCard } from "./ProposalCard.js";

describe("ProposalCard", () => {
	for (const p of proposals) {
		it(`renders ${p.id} (${p.kind}) with title, target, and diff`, () => {
			render(<ProposalCard proposal={p} />);
			expect(screen.getByText(p.title)).toBeInTheDocument();
			expect(screen.getByText(p.target)).toBeInTheDocument();
			const firstAfter = p.diff[0].after;
			const snippet = firstAfter.slice(0, Math.min(20, firstAfter.length));
			expect(
				screen.getByText(
					(_content, node) => node?.textContent?.includes(snippet) ?? false,
				),
			).toBeInTheDocument();
		});
	}
});
