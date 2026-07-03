import type { ModelInfo } from "@inkstone/protocol";
import { Brain, Eye, Star } from "lucide-react";
import { useId } from "react";
import { isModelEnabled } from "@/lib/enabledModels.js";
import { groupByVendor, modelDisplayName } from "@/lib/modelVendor.js";
import { cn } from "@/lib/utils.js";
import { Badge } from "./ui/badge.js";

export interface ModelCatalogTableProps {
	models: readonly ModelInfo[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	disabled?: boolean;
	/** The provider's display label, e.g. "OpenAI". Backs the vendor derivation:
	 * a bare-named model (Codex) is grouped under this label. */
	providerLabel: string;
	/** Ids enabled for chat. Empty (or omitted) means "no curation → all enabled" (ADR-0024); a non-empty set enables only those ids. */
	enabledIds?: readonly string[];
	/** Toggle a model's chat-enabled membership. `next` is the desired state. Omitting it (with `enabledIds`) hides the toggle. */
	onToggleEnabled?: (id: string, next: boolean) => void;
}

const LOCKED_DEFAULT_HINT = "Set another model as default to disable it.";

/** Model catalog as a table (ADR-0024): one row per model with name and capability chips; one row is "Preferred", others reveal a "Set as preferred" action. Presentational. */
export function ModelCatalogTable({
	models,
	selectedId,
	onSelect,
	disabled,
	providerLabel,
	enabledIds,
	onToggleEnabled,
}: ModelCatalogTableProps) {
	const hintId = useId();
	// Membership follows the shared ADR-0024 rule: an empty (or omitted)
	// `enabledIds` means "no curation → all enabled"; a non-empty set enables only
	// its members.
	const isEnabled = (id: string) => isModelEnabled(enabledIds ?? [], id);
	if (models.length === 0) {
		return (
			<div className="rounded-md border border-input border-dashed px-3 py-8 text-center text-muted-foreground text-sm">
				No models available. Connect a provider to see its models.
			</div>
		);
	}

	// Rows are grouped under their vendor (the model MAKER — OpenAI, Anthropic…),
	// which is derived from the model name / provider label. Each vendor is its
	// own `<tbody>` rowgroup so the header `<th scope="rowgroup">` labels the
	// model rows beneath it for assistive tech.
	const groups = groupByVendor(models, providerLabel);

	return (
		<div className="overflow-hidden rounded-md border border-input">
			<table className="w-full caption-bottom text-sm">
				{groups.map((group) => (
					<VendorRows
						key={group.vendor}
						group={group}
						selectedId={selectedId}
						onSelect={onSelect}
						disabled={disabled}
						isEnabled={isEnabled}
						onToggleEnabled={onToggleEnabled}
						hintId={hintId}
					/>
				))}
			</table>
			{onToggleEnabled ? (
				<p id={hintId} className="sr-only">
					{LOCKED_DEFAULT_HINT}
				</p>
			) : null}
		</div>
	);
}

interface VendorRowsProps {
	group: { readonly vendor: string; readonly models: readonly ModelInfo[] };
	selectedId: string | null;
	onSelect: (id: string) => void;
	disabled?: boolean;
	isEnabled: (id: string) => boolean;
	onToggleEnabled?: (id: string, next: boolean) => void;
	hintId: string;
}

/** One vendor's section as its own `<tbody>` rowgroup: a header row naming the
 * vendor, then a row per model. */
function VendorRows({
	group,
	selectedId,
	onSelect,
	disabled,
	isEnabled,
	onToggleEnabled,
	hintId,
}: VendorRowsProps) {
	// The toggle column only exists when a toggle handler is provided.
	const columns = onToggleEnabled ? 3 : 2;
	return (
		<tbody>
			<tr className="border-input border-b bg-muted/30">
				<th
					scope="rowgroup"
					colSpan={columns}
					className="px-2 py-1.5 text-left font-medium text-[11px] text-muted-foreground uppercase tracking-wide"
				>
					{group.vendor}
				</th>
			</tr>
			{group.models.map((m) => {
				const preferred = m.id === selectedId;
				const enabled = isEnabled(m.id);
				// The current default must stay enabled (mirrors Core's slice-2
				// invariant: default ∈ enabled). Its disable toggle is locked
				// until another model is made default.
				const lockedDefault = preferred;
				return (
					<tr
						key={m.id}
						className="group/row border-input border-b transition-colors last:border-0 hover:bg-muted/50"
					>
						<td className="p-2 align-middle">
							<div className="flex items-center gap-2.5">
								<div className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground">
									<Brain className="size-4" aria-hidden />
								</div>
								<div className="flex min-w-0 flex-col gap-0.5">
									<div className="flex items-center gap-1.5">
										<span className="truncate font-medium text-sm">
											{modelDisplayName(m)}
										</span>
									</div>
									<div className="flex items-center gap-2 text-muted-foreground">
										{m.reasoning ? (
											<span className="inline-flex items-center gap-1 text-[11px]">
												<Brain className="size-3" aria-hidden />
												Reasoning
											</span>
										) : null}
										{m.input.includes("image") ? (
											<span className="inline-flex items-center gap-1 text-[11px]">
												<Eye className="size-3" aria-hidden />
												Vision
											</span>
										) : null}
									</div>
								</div>
							</div>
						</td>
						{onToggleEnabled ? (
							<td className="w-0 p-2 align-middle">
								<label
									className={cn(
										"inline-flex",
										lockedDefault || disabled
											? "cursor-not-allowed"
											: "cursor-pointer",
									)}
									title={lockedDefault ? LOCKED_DEFAULT_HINT : undefined}
								>
									{/* Native checkbox carries the a11y state (label, checked,
									    disabled, description); visually hidden via `peer`, the
									    sibling span renders the switch track + thumb. */}
									<input
										type="checkbox"
										className="peer sr-only"
										aria-label="Enabled for chat"
										aria-describedby={lockedDefault ? hintId : undefined}
										checked={enabled}
										disabled={disabled || lockedDefault}
										onChange={() => onToggleEnabled(m.id, !enabled)}
									/>
									<span
										aria-hidden
										className={cn(
											"inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent p-0.5 transition-colors peer-focus-visible:ring-1 peer-focus-visible:ring-ring peer-disabled:opacity-60",
											enabled ? "bg-primary" : "bg-input",
										)}
									>
										<span
											className={cn(
												"size-4 rounded-full bg-background shadow-sm transition-transform",
												enabled ? "translate-x-4" : "translate-x-0",
											)}
										/>
									</span>
								</label>
							</td>
						) : null}
						<td className="w-0 p-2 align-middle">
							{preferred ? (
								<Badge variant="primary" className="whitespace-nowrap">
									<Star className="size-3 fill-current" aria-hidden />
									Preferred
								</Badge>
							) : (
								<button
									type="button"
									disabled={disabled}
									onClick={() => onSelect(m.id)}
									// Always visible (was opacity-0 → hover-only, so it was
									// undiscoverable and unreachable on touch); calm at rest,
									// brighter on hover/focus.
									className="cursor-pointer whitespace-nowrap rounded-md border border-border px-2 py-1 font-medium text-muted-foreground text-xs transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
								>
									Set as preferred
								</button>
							)}
						</td>
					</tr>
				);
			})}
		</tbody>
	);
}
