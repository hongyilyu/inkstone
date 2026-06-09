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

// Stub WsClient whose `entity/list` returns `todos`. `useEntities` reads
// the live Todos via this method (slice 11) and merges them with the non-todo
// mock collections; the unused methods die if exercised.
function makeRuntime(todos: EntityListResult["entities"]) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		threadGet: () => unused,
		listEntities: () => Effect.succeed({ entities: todos }),
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
	todos: EntityListResult["entities"],
	overrides?: { selectedId?: string | null; onSelect?: (id: string) => void },
) {
	const runtime = makeRuntime(todos);
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
	it("lists every entity of the kind (people stay on mock)", async () => {
		renderCollection("person", []);
		expect(await screen.findByText("Priya Nair")).toBeInTheDocument();
		// Six people in the mock workspace, one selectable row each.
		expect(screen.getAllByRole("button")).toHaveLength(6);
	});

	it("renders live Todos read from entity/list", async () => {
		renderCollection("todo", [
			{
				id: "01900000-0000-7000-8000-000000000030",
				type: "todo",
				data: { title: "buy milk", done: false },
				created_at: 1_700_000_000_000,
				updated_at: 1_700_000_000_000,
			},
		]);
		// The live Todo's title is rendered from `data.title`.
		expect(await screen.findByText("buy milk")).toBeInTheDocument();
		// The mock Todos are NOT shown — Todos are live this slice.
		expect(
			screen.queryByText("Backfill /v2/contacts before the cutover window"),
		).not.toBeInTheDocument();
	});

	it("filters as you search", async () => {
		const user = userEvent.setup();
		renderCollection("person", []);
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
		renderCollection("person", []);
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
		renderCollection("person", [], { onSelect });
		await screen.findByText("Priya Nair");

		await user.click(screen.getByRole("button", { name: /priya nair/i }));
		expect(onSelect).toHaveBeenCalledWith("person_priya");
	});
});
