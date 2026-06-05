import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import { EntityCollection } from "./EntityCollection";

function renderPeople(overrides?: {
	selectedId?: string | null;
	onSelect?: (id: string) => void;
}) {
	return renderWithQuery(
		<EntityCollection
			kind="person"
			selectedId={overrides?.selectedId ?? null}
			onSelect={overrides?.onSelect ?? (() => {})}
			onClose={() => {}}
		/>,
	);
}

afterEach(cleanup);

describe("EntityCollection", () => {
	it("lists every entity of the kind", async () => {
		renderPeople();
		expect(await screen.findByText("Priya Nair")).toBeInTheDocument();
		// Six people in the mock workspace, one selectable row each.
		expect(screen.getAllByRole("button")).toHaveLength(6);
	});

	it("filters as you search", async () => {
		const user = userEvent.setup();
		renderPeople();
		await screen.findByText("Priya Nair");

		await user.type(
			screen.getByRole("textbox", { name: /search people/i }),
			"marco",
		);

		expect(screen.getByText("Marco Reyes")).toBeInTheDocument();
		expect(screen.queryByText("Priya Nair")).not.toBeInTheDocument();
	});

	it("teaches an empty result instead of going blank", async () => {
		const user = userEvent.setup();
		renderPeople();
		await screen.findByText("Priya Nair");

		await user.type(
			screen.getByRole("textbox", { name: /search people/i }),
			"zzznobody",
		);

		expect(screen.getByText(/no matches/i)).toBeInTheDocument();
		expect(screen.queryByText("Priya Nair")).not.toBeInTheDocument();
	});

	it("reports the selected row id", async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		renderPeople({ onSelect });
		await screen.findByText("Priya Nair");

		await user.click(screen.getByRole("button", { name: /priya nair/i }));
		expect(onSelect).toHaveBeenCalledWith("person_priya");
	});
});
