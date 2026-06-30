import type { ModelInfo } from "@inkstone/protocol";
import { ChevronLeft } from "lucide-react";
import { ModelCatalogTable } from "./ModelCatalogTable.js";

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
}

/** A single provider's detail (ADR-0024): a header with the provider label + a Back control, and that provider's models listed with the existing "Preferred" affordance. Presentational; the parent owns selection + persistence. */
export function ProviderModelsDetail({
	label,
	models,
	selectedId,
	onSelect,
	enabledIds,
	onToggleEnabled,
	onBack,
}: ProviderModelsDetailProps) {
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
			</div>
			<p className="text-muted-foreground text-xs">
				Toggle which models are available in chat, and set the one new chats use
				by default.
			</p>
			<ModelCatalogTable
				models={models}
				selectedId={selectedId}
				onSelect={onSelect}
				enabledIds={enabledIds}
				onToggleEnabled={onToggleEnabled}
			/>
		</div>
	);
}
