import type { RunHistoryResult } from "@inkstone/protocol";
import { WsClient, type WsError } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import App from "./App.js";
import { RuntimeProvider } from "./runtime.js";

describe("App", () => {
	afterEach(cleanup);

	it("renders the three-region shell with the recent-runs rail", () => {
		// ChatColumn + Sidebar now call useRuntime(), so App's tree requires a
		// RuntimeProvider (main.tsx wraps it; this test does the same). A stub url
		// opens no socket at mount — the runtime is lazy and this test never sends
		// or reads (the threadList/run-history queries stay pending, which renders
		// an empty sidebar + a loading feed, not a throw).
		renderWithQuery(
			<RuntimeProvider config={{ url: "ws://stub/ws" }}>
				<App />
			</RuntimeProvider>,
		);
		expect(
			screen.getByRole("complementary", { name: /sidebar/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("main")).toBeInTheDocument();
		// The right rail is now the recent-Runs feed (replacing the visual-only
		// ActivityRail), named for its collapse control.
		expect(
			screen.getByRole("complementary", { name: /recent runs/i }),
		).toBeInTheDocument();
	});

	it("opens a run's thread when a feed row is clicked", async () => {
		const opened: string[] = [];
		const unused = Effect.die("not exercised in this test");
		const stub = WsClient.of({
			threadCreate: () => unused,
			postMessage: () => unused,
			threadList: () => Effect.succeed({ threads: [] }),
			getRunHistory: (): Effect.Effect<RunHistoryResult, WsError> =>
				Effect.succeed({
					runs: [
						{
							run_id: "r1",
							thread_id: "thread-77",
							title: "Clickable run",
							kind: "done",
							at: Date.now(),
						},
					],
				}),
			threadGet: () => unused,
			listEntities: () => Effect.succeed({ entities: [] }),
			entityMutate: () => unused,
			subscribeRun: () => unused,
			cancelRun: () => unused,
			providerStatus: () => unused,
			providerLoginStart: () => unused,
			modelCatalog: () => unused,
			settingsGet: () => unused,
			settingsSet: () => unused,
			proposalGet: () => unused,
			proposalDecide: () => unused,
			messageSearch: () => unused,
			proposalNotifications: () => unused,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const Wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
			</QueryClientProvider>
		);
		// App is router-free; the route injects onOpenThread. Mirror that here.
		render(<App onOpenThread={(id) => opened.push(id)} />, {
			wrapper: Wrapper,
		});

		const row = await screen.findByRole("button", { name: /Clickable run/ });
		await userEvent.click(row);
		expect(opened).toEqual(["thread-77"]);
	});
});
