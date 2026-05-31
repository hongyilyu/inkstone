import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { proposals } from "@/data/mock/proposals";
import { ProposalCard } from "./ProposalCard.js";

describe("ProposalCard", () => {
	afterEach(cleanup);
	for (const p of proposals) {
		it(`renders ${p.id} (${p.kind}) with title, target, and diff`, () => {
			render(<ProposalCard proposal={p} />);
			expect(screen.getByText(p.title)).toBeInTheDocument();
			expect(screen.getByText(p.target)).toBeInTheDocument();
			const firstAfter = p.diff[0].after;
			const snippet = firstAfter.slice(0, Math.min(20, firstAfter.length));
			const matches = screen.getAllByText(
				(_content, node) => node?.textContent?.includes(snippet) ?? false,
			);
			expect(matches.length).toBeGreaterThan(0);
		});
	}
});
