import type { ModelInfo, ProviderTestResult } from "@inkstone/protocol";
import { ChevronLeft, CircleCheck, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ModelCatalogTable } from "./ModelCatalogTable.js";
import { Button } from "./ui/button.js";

export interface ProviderModelsDetailProps {
	/** The provider's display label, e.g. "OpenAI". */
	label: string;
	/** That provider's catalog models. */
	models: readonly ModelInfo[];
	/** The currently-preferred model id (null when none chosen). */
	selectedId: string | null;
	onSelect: (id: string) => void;
	/** Ids enabled for chat (empty = "all enabled", ADR-0024). */
	enabledIds: readonly string[];
	/** Toggle a model's chat-enabled membership. */
	onToggleEnabled: (id: string, next: boolean) => void;
	/** Return to the provider list. */
	onBack: () => void;
	/** Whether this provider is connected (ADR-0062). When false, its models
	 * can't be set as the chat default — picking one would run tokenless — so the
	 * catalog's select/toggle affordances are disabled with a hint. */
	connected?: boolean;
	/** Probe this provider's liveness (ADR-0062). The parent resolves the model to
	 * test and calls `provider/test`; this component owns the transient verdict UI.
	 * When absent (or `canTest` is false) the Test button is disabled. */
	onTest?: () => Promise<ProviderTestResult>;
	/** Whether a testable model exists for this provider (false ⇒ disable Test). */
	canTest?: boolean;
}

// Transient liveness state (ADR-0062): never persisted, cleared on provider
// switch or re-test. `pending` is in-flight; `alive`/`dead` are the verdict.
type TestState =
	| { readonly kind: "idle" }
	| { readonly kind: "pending" }
	| { readonly kind: "alive" }
	| { readonly kind: "dead"; readonly message?: string };

/** A single provider's detail (ADR-0024): a header with the provider label, a Back control, and a liveness "Test" button (ADR-0062); below, that provider's models with the existing "Preferred" affordance. Presentational for selection/persistence (the parent owns those); the transient test verdict is owned here. */
export function ProviderModelsDetail({
	label,
	models,
	selectedId,
	onSelect,
	enabledIds,
	onToggleEnabled,
	onBack,
	onTest,
	canTest = true,
	connected = true,
}: ProviderModelsDetailProps) {
	const [test, setTest] = useState<TestState>({ kind: "idle" });

	// Clear the verdict when the focused provider changes — the indicator is
	// per-provider and must not bleed across a switch (ADR-0062).
	const prevLabel = useRef(label);
	useEffect(() => {
		if (prevLabel.current !== label) {
			prevLabel.current = label;
			setTest({ kind: "idle" });
		}
	}, [label]);

	const runTest = () => {
		if (onTest === undefined) return;
		// Re-test clears the prior verdict first (see above: no stale indicator).
		setTest({ kind: "pending" });
		onTest()
			.then((r) =>
				setTest(
					r.alive ? { kind: "alive" } : { kind: "dead", message: r.message },
				),
			)
			.catch(() =>
				setTest({ kind: "dead", message: "Couldn't reach the provider." }),
			);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4">
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={onBack}
					className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 font-medium text-muted-foreground text-sm transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
				>
					<ChevronLeft className="size-4" aria-hidden />
					Back
				</button>
				<h3 className="font-semibold text-base">{label}</h3>
				<div className="ml-auto flex items-center gap-2">
					{test.kind !== "idle" && (
						<span
							role="status"
							data-testid="liveness-status"
							className={
								test.kind === "alive"
									? "flex items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400"
									: test.kind === "dead"
										? "flex items-center gap-1 text-destructive text-xs"
										: "flex items-center gap-1 text-muted-foreground text-xs"
							}
						>
							{test.kind === "pending" && (
								<>
									<Loader2 className="size-3.5 animate-spin" aria-hidden />
									Testing…
								</>
							)}
							{test.kind === "alive" && (
								<>
									<CircleCheck className="size-3.5" aria-hidden />
									Working
								</>
							)}
							{test.kind === "dead" && (
								<>
									<TriangleAlert className="size-3.5" aria-hidden />
									{test.message ?? "Not working"}
								</>
							)}
						</span>
					)}
					<Button
						variant="chip"
						size="sm"
						disabled={
							!canTest || onTest === undefined || test.kind === "pending"
						}
						onClick={runTest}
					>
						Test
					</Button>
				</div>
			</div>
			<p className="text-muted-foreground text-xs">
				{connected
					? "Toggle which models are available in chat, and set the one new chats use by default."
					: "Connect this provider to enable its models and set one as your default."}
			</p>
			<ModelCatalogTable
				models={models}
				selectedId={selectedId}
				onSelect={onSelect}
				enabledIds={enabledIds}
				onToggleEnabled={onToggleEnabled}
				// Not connected → picking a default would run tokenless, so lock
				// select/toggle here (ADR-0062); the row above hints why.
				disabled={!connected}
			/>
		</div>
	);
}
