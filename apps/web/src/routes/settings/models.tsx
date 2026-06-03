import { createFileRoute } from "@tanstack/react-router";

/**
 * `/settings/models` (ADR-0024). Slice 4 ships the shell + heading so the
 * route is reachable and testable; the provider-connection card, global effort
 * control, and model catalog table land in the following slices.
 */
function ModelsSettings() {
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-6">
			<div>
				<h2 className="mb-1 font-bold text-2xl">Models</h2>
				<p className="text-muted-foreground text-sm">
					Connect a provider, choose your preferred model, and set how hard it
					thinks.
				</p>
			</div>
		</div>
	);
}

export const Route = createFileRoute("/settings/models")({
	component: ModelsSettings,
});
