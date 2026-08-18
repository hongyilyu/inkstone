import { people } from "@test/lib/libraryItems.fixtures";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntityRow } from "@/components/library/EntityRow";

const person = (id: string) => {
	const p = people.find((x) => x.id === id);
	if (!p) throw new Error(`missing person ${id}`);
	return p;
};

afterEach(cleanup);

describe("EntityRow", () => {
	it("renders title + subtitle and reports selection", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(<EntityRow entity={person("person_priya")} onSelect={onSelect} />);

		expect(screen.getByText("Priya Nair")).toBeInTheDocument();
		expect(screen.getByText(/Owns the SDK examples/)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /priya nair/i }));
		expect(onSelect).toHaveBeenCalledWith("person_priya");
	});
});
