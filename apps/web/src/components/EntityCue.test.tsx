import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEntityCueStore, showEntityCue } from "@/store/entityCue";
import { EntityCue } from "./EntityCue";

// `showEntityCue` starts a real auto-dismiss timer; fake them so no stray timer
// fires across tests, and reset the single-slot store between cases.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	resetEntityCueStore();
	vi.useRealTimers();
	cleanup();
});

describe("EntityCue", () => {
	it("renders the cue verb in a live region with the magenta check", () => {
		showEntityCue("Saved");
		render(<EntityCue />);

		expect(screen.getByRole("status")).toHaveTextContent("Saved");
		expect(screen.getByTestId("entity-cue-check")).toBeInTheDocument();
	});

	it("renders nothing visible when the slot is empty", () => {
		resetEntityCueStore();
		render(<EntityCue />);

		expect(screen.queryByText(/Saved|Created|Deleted/)).toBeNull();
	});

	it("shows the verb word without any animation having run (headless/reduced-motion)", () => {
		// jsdom has no motion-safe support, so the word must be painted in the DOM
		// regardless of the entrance animation — visibility is never gated on motion.
		showEntityCue("Deleted");
		render(<EntityCue />);

		expect(screen.getByText("Deleted")).toBeInTheDocument();
	});

	it("re-keys the pill on a repeat verb so it re-announces", () => {
		showEntityCue("Saved");
		const { rerender } = render(<EntityCue />);
		const first = screen.getByRole("status").getAttribute("data-cue-key");

		showEntityCue("Saved");
		rerender(<EntityCue />);
		const second = screen.getByRole("status").getAttribute("data-cue-key");

		expect(first).not.toBeNull();
		expect(second).not.toBe(first);
	});
});
