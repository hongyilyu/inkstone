import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JournalEntry, Person } from "@/lib/libraryItems";
import { EntityDetail } from "./EntityDetail";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigate,
	};
});

afterEach(() => {
	cleanup();
	navigate.mockReset();
});

const ada: Person = {
	id: "person_ada",
	kind: "person",
	name: "Ada Lovelace",
	note: "Current canonical name",
	createdAt: "fixture",
	recency: 2,
};

function journal(body: JournalEntry["body"]): JournalEntry {
	return {
		id: "journal_1",
		kind: "journal_entry",
		occurredAt: "2026-06-10T10:30:00",
		body,
		createdAt: "fixture",
		recency: 1,
	};
}

describe("EntityDetail Journal Entry body", () => {
	it("renders text-only Journal Entries normally", () => {
		render(
			<EntityDetail
				entity={journal([{ type: "text", text: "Bought milk." }])}
				allEntities={[]}
			/>,
		);

		expect(screen.getAllByText("Bought milk.")).toHaveLength(2);
	});

	it("renders mixed text and inline ref chips in order", () => {
		render(
			<EntityDetail
				entity={journal([
					{ type: "text", text: "Met " },
					{
						type: "entity_ref",
						refId: "ref_1",
						targetEntityId: ada.id,
						targetKind: "person",
						targetTitle: "Stale Ada",
						labelSnapshot: "Ada",
					},
					{ type: "text", text: " at school." },
				])}
				allEntities={[ada]}
			/>,
		);

		const body = screen.getByText("Body").nextElementSibling as HTMLElement;
		expect(body).toHaveTextContent("Met Ada Lovelace at school.");
		expect(
			within(body).getByRole("button", {
				name: "Ada Lovelace",
			}),
		).toBeInTheDocument();
	});

	it("falls back to label_snapshot when the target is not loaded", () => {
		render(
			<EntityDetail
				entity={journal([
					{ type: "text", text: "Met " },
					{
						type: "entity_ref",
						refId: "ref_1",
						targetEntityId: "missing_person",
						targetKind: "person",
						labelSnapshot: "Ada snapshot",
					},
				])}
				allEntities={[]}
			/>,
		);

		expect(screen.getByText("Ada snapshot")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Ada snapshot" }),
		).not.toBeInTheDocument();
	});

	it("opens a resolvable ref in the Library detail rail", async () => {
		const user = userEvent.setup();
		render(
			<EntityDetail
				entity={journal([
					{ type: "text", text: "Met " },
					{
						type: "entity_ref",
						refId: "ref_1",
						targetEntityId: ada.id,
						targetKind: "person",
						targetTitle: "Stale Ada",
						labelSnapshot: "Ada",
					},
				])}
				allEntities={[ada]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Ada Lovelace" }));

		expect(navigate).toHaveBeenCalledWith({
			to: "/library/$kind",
			params: { kind: "people" },
			search: { id: "person_ada" },
		});
	});
});
