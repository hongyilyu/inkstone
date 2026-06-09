import type { EntityListResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { EntityCollection } from "./EntityCollection";

// Live People rows the stub serves for `type === "person"` (slice 3). The
// People collection reads these from Core now; the static mock people
// (Priya/Marco/…) are no longer merged in.
const livePeople: EntityListResult["entities"] = [
	{
		id: "01900000-0000-7000-8000-0000000000a1",
		type: "person",
		data: { name: "Ada Lovelace", note: "met at the analytical engine demo" },
		created_at: 1_700_000_100_000,
		updated_at: 1_700_000_100_000,
	},
	{
		id: "01900000-0000-7000-8000-0000000000a2",
		type: "person",
		data: { name: "Grace Hopper" },
		created_at: 1_700_000_000_000,
		updated_at: 1_700_000_000_000,
	},
];

// Stub WsClient whose `entity/list` answers by type: People for `"person"`,
// Todos for everything else. `useEntities` reads BOTH live Todos and live
// People (slice 3) and merges them with the remaining (project/recipe) mocks;
// the unused methods die if exercised.
function makeRuntime(
	people: EntityListResult["entities"],
	todos: EntityListResult["entities"],
) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		threadGet: () => unused,
		listEntities: (type) =>
			Effect.succeed({ entities: type === "person" ? people : todos }),
		subscribeRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		proposalDecide: () => unused,
		proposalNotifications: () => unused,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

function renderCollection(
	kind: "person" | "todo",
	rows: {
		people?: EntityListResult["entities"];
		todos?: EntityListResult["entities"];
	},
	overrides?: { selectedId?: string | null; onSelect?: (id: string) => void },
) {
	const runtime = makeRuntime(rows.people ?? [], rows.todos ?? []);
	const client = new QueryClient({
		defaultOptions: {
			queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
		},
	});
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
	return render(
		<EntityCollection
			kind={kind}
			selectedId={overrides?.selectedId ?? null}
			onSelect={overrides?.onSelect ?? (() => {})}
			onClose={() => {}}
		/>,
		{ wrapper: Wrapper },
	);
}

afterEach(cleanup);

describe("EntityCollection", () => {
	it("lists live People read from entity/list (mock people no longer merged)", async () => {
		renderCollection("person", { people: livePeople });
		// The seeded live People are listed…
		expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
		expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
		// …and the static mock person is gone (People are live this slice).
		expect(screen.queryByText("Priya Nair")).not.toBeInTheDocument();
	});

	it("renders live Todos read from entity/list", async () => {
		renderCollection("todo", {
			todos: [
				{
					id: "01900000-0000-7000-8000-000000000030",
					type: "todo",
					data: { title: "buy milk", done: false },
					created_at: 1_700_000_000_000,
					updated_at: 1_700_000_000_000,
				},
			],
		});
		// The live Todo's title is rendered from `data.title`.
		expect(await screen.findByText("buy milk")).toBeInTheDocument();
		// The mock Todos are NOT shown — Todos are live this slice.
		expect(
			screen.queryByText("Backfill /v2/contacts before the cutover window"),
		).not.toBeInTheDocument();
	});

	it("filters as you search", async () => {
		const user = userEvent.setup();
		renderCollection("person", { people: livePeople });
		await screen.findByText("Grace Hopper");

		await user.type(
			screen.getByRole("textbox", { name: /search people/i }),
			"grace",
		);

		expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
		expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
	});

	it("teaches an empty result instead of going blank", async () => {
		const user = userEvent.setup();
		renderCollection("person", { people: livePeople });
		await screen.findByText("Ada Lovelace");

		await user.type(
			screen.getByRole("textbox", { name: /search people/i }),
			"zzznobody",
		);

		expect(screen.getByText(/no matches/i)).toBeInTheDocument();
		expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
	});

	it("reports the selected row id", async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		renderCollection("person", { people: livePeople }, { onSelect });
		await screen.findByText("Ada Lovelace");

		await user.click(screen.getByRole("button", { name: /ada lovelace/i }));
		expect(onSelect).toHaveBeenCalledWith(
			"01900000-0000-7000-8000-0000000000a1",
		);
	});
});
