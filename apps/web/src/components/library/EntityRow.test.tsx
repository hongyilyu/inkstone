import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { people, todos } from "@/data/mock/entities";
import { resetLibraryStore } from "@/store/library";
import { EntityRow, TodoRow } from "./EntityRow";

const todo = (id: string) => {
	const t = todos.find((x) => x.id === id);
	if (!t) throw new Error(`missing todo ${id}`);
	return t;
};
const person = (id: string) => {
	const p = people.find((x) => x.id === id);
	if (!p) throw new Error(`missing person ${id}`);
	return p;
};

beforeEach(() => resetLibraryStore());
afterEach(cleanup);

describe("TodoRow", () => {
	it("toggles done via the checkbox and reflects it", async () => {
		const user = userEvent.setup();
		render(
			<ul>
				<TodoRow todo={todo("todo_schedule_alice")} onSelect={() => {}} />
			</ul>,
		);

		const checkbox = screen.getByRole("button", { name: /mark .* done/i });
		expect(checkbox).toHaveAttribute("aria-pressed", "false");

		await user.click(checkbox);

		expect(
			screen.getByRole("button", { name: /mark .* not done/i }),
		).toHaveAttribute("aria-pressed", "true");
	});

	it("opens detail without toggling done", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(
			<ul>
				<TodoRow todo={todo("todo_schedule_alice")} onSelect={onSelect} />
			</ul>,
		);

		await user.click(
			screen.getByRole("button", { name: /^Send Alice the updated/i }),
		);

		expect(onSelect).toHaveBeenCalledWith("todo_schedule_alice");
		// The open affordance must not flip done.
		expect(
			screen.getByRole("button", { name: /mark .* done/i }),
		).toHaveAttribute("aria-pressed", "false");
	});

	it("flags an overdue todo with a label, not colour alone", () => {
		render(
			<ul>
				<TodoRow todo={todo("todo_dentist")} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.getByText("Overdue")).toBeInTheDocument();
	});

	it("shows the due label when not overdue", () => {
		render(
			<ul>
				<TodoRow todo={todo("todo_schedule_alice")} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.getByText("Fri")).toBeInTheDocument();
		expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
	});
});

describe("EntityRow", () => {
	it("renders title + subtitle and reports selection", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(<EntityRow entity={person("person_priya")} onSelect={onSelect} />);

		expect(screen.getByText("Priya Nair")).toBeInTheDocument();
		expect(screen.getByText("Staff engineer, Platform")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /priya nair/i }));
		expect(onSelect).toHaveBeenCalledWith("person_priya");
	});
});
