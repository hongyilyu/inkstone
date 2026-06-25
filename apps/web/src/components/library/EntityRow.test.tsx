import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Todo } from "@/lib/libraryItems";
import { people, todos } from "@/lib/libraryItems.fixtures";
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

afterEach(cleanup);

describe("TodoRow", () => {
	it("shows status read-only — no done toggle (editing is deferred)", () => {
		render(
			<ul>
				<TodoRow todo={todo("todo_schedule_alice")} onSelect={() => {}} />
			</ul>,
		);
		// The old "Mark done" toggle is gone; an active todo carries an Active mark.
		expect(
			screen.queryByRole("button", { name: /mark .* done/i }),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("Active")).toBeInTheDocument();
	});

	it("marks a completed todo without offering a toggle", () => {
		render(
			<ul>
				<TodoRow todo={todo("todo_cutover")} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.getByLabelText("Completed")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /mark/i }),
		).not.toBeInTheDocument();
	});

	it("marks a dropped todo with its own glyph", () => {
		render(
			<ul>
				<TodoRow todo={todo("todo_old_vendor")} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.getByLabelText("Dropped")).toBeInTheDocument();
	});

	it("opens detail when the row is clicked", async () => {
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
	});

	it("flags an overdue active todo with a label, not colour alone", () => {
		// Force a due date far in the past so the assertion is clock-proof.
		const overdue: Todo = {
			...todo("todo_dentist"),
			dueAt: "2000-01-01T09:00:00",
		};
		render(
			<ul>
				<TodoRow todo={overdue} onSelect={() => {}} />
			</ul>,
		);
		// Overdue keeps the date so multiple overdue rows stay distinguishable.
		expect(screen.getByText("Overdue · 2000-01-01")).toBeInTheDocument();
	});

	it("shows the due date when not overdue", () => {
		const future: Todo = {
			...todo("todo_schedule_alice"),
			dueAt: "2999-01-02T17:00:00",
		};
		render(
			<ul>
				<TodoRow todo={future} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.getByText("2999-01-02")).toBeInTheDocument();
		expect(screen.queryByText(/Overdue/)).not.toBeInTheDocument();
	});

	it("shows an Available <date> chip when the todo is deferred", () => {
		// Far-future defer date so the chip is clock-proof.
		const deferred: Todo = {
			...todo("todo_schedule_alice"),
			deferAt: "2999-01-05T00:00:00",
		};
		render(
			<ul>
				<TodoRow todo={deferred} onSelect={() => {}} />
			</ul>,
		);
		// Chip shows the YYYY-MM-DD day slice, matching DueChip's format.
		expect(screen.getByText("Available 2999-01-05")).toBeInTheDocument();
	});

	it("shows no Available chip when the todo is not deferred", () => {
		render(
			<ul>
				<TodoRow todo={todo("todo_schedule_alice")} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.queryByText(/^Available /)).not.toBeInTheDocument();
	});

	it("shows both the due date and the Available chip when the todo has both", () => {
		const both: Todo = {
			...todo("todo_schedule_alice"),
			deferAt: "2999-01-05T00:00:00",
			dueAt: "2999-01-09T17:00:00",
		};
		render(
			<ul>
				<TodoRow todo={both} onSelect={() => {}} />
			</ul>,
		);
		expect(screen.getByText("2999-01-09")).toBeInTheDocument();
		expect(screen.getByText("Available 2999-01-05")).toBeInTheDocument();
	});
});

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
