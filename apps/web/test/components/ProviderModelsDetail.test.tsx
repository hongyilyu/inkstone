import type { ModelInfo, ProviderTestResult } from "@inkstone/protocol";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderModelsDetail } from "@/components/ProviderModelsDetail.js";

afterEach(cleanup);

const MODELS: readonly ModelInfo[] = [
	{ id: "m1", name: "Model One", reasoning: false, input: [] },
];

/** Minimal props; each test overrides `label`/`onTest` as needed. */
function baseProps() {
	return {
		label: "Provider A",
		models: MODELS,
		selectedId: null,
		onSelect: vi.fn(),
		enabledIds: [] as readonly string[],
		onToggleEnabled: vi.fn(),
		onBack: vi.fn(),
		canTest: true,
		connected: true,
	};
}

describe("ProviderModelsDetail liveness", () => {
	it("does not paint a stale verdict when the provider switches mid-probe", async () => {
		// A probe that never resolves until we release it — simulating an in-flight
		// request that only settles AFTER the user has switched providers.
		let release!: (r: ProviderTestResult) => void;
		const onTest = vi.fn(
			() =>
				new Promise<ProviderTestResult>((resolve) => {
					release = resolve;
				}),
		);

		const props = baseProps();
		const { rerender } = render(
			<ProviderModelsDetail key="provider-a" {...props} onTest={onTest} />,
		);

		// Start the probe on Provider A → "Testing…".
		fireEvent.click(screen.getByRole("button", { name: "Test" }));
		expect(screen.getByTestId("liveness-status")).toHaveTextContent("Testing…");

		// Switch to Provider B before the probe settles. The parent keys the detail
		// by provider id, so the switch REMOUNTS it — fresh idle state, no indicator.
		rerender(
			<ProviderModelsDetail
				key="provider-b"
				{...props}
				label="Provider B"
				onTest={onTest}
			/>,
		);
		expect(screen.queryByTestId("liveness-status")).toBeNull();

		// Provider A's probe finally settles "alive" — it must NOT paint on B.
		release({ alive: true });
		await Promise.resolve();
		await waitFor(() => {
			expect(screen.queryByTestId("liveness-status")).toBeNull();
		});
	});

	it("paints the verdict for a probe that settles on the same provider", async () => {
		let release!: (r: ProviderTestResult) => void;
		const onTest = vi.fn(
			() =>
				new Promise<ProviderTestResult>((resolve) => {
					release = resolve;
				}),
		);

		render(<ProviderModelsDetail {...baseProps()} onTest={onTest} />);

		fireEvent.click(screen.getByRole("button", { name: "Test" }));
		expect(screen.getByTestId("liveness-status")).toHaveTextContent("Testing…");

		// No switch → the settled verdict is current and paints.
		release({ alive: true });
		await waitFor(() => {
			expect(screen.getByTestId("liveness-status")).toHaveTextContent(
				"Working",
			);
		});
	});
});
