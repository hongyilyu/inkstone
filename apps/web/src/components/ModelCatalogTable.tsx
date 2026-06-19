import type { ModelInfo } from "@inkstone/protocol";
import { Brain, Eye, Star } from "lucide-react";
import { Badge } from "./ui/badge.js";

/** Map a model's output price to a t3-style cost tier badge. */
function CostBadge({ cost }: { cost: number }) {
	const { label, dollars } =
		cost <= 0
			? { label: "Free", dollars: 0 }
			: cost < 5
				? { label: "Low cost", dollars: 1 }
				: cost < 15
					? { label: "Medium cost", dollars: 2 }
					: { label: "High cost", dollars: 3 };
	return (
		<span
			role="img"
			aria-label={label}
			className="inline-flex items-center font-mono font-semibold text-[10px] text-muted-foreground tabular-nums tracking-tight"
		>
			{dollars === 0
				? "$0"
				: Array.from({ length: dollars }, (_, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length glyph repeat
						<span key={i}>$</span>
					))}
		</span>
	);
}

export interface ModelCatalogTableProps {
	models: readonly ModelInfo[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	disabled?: boolean;
}

/** Model catalog as a table (ADR-0024): one row per model with name, cost tier, capability chips; one row is "Preferred", others reveal a "Set as preferred" action. Presentational. */
export function ModelCatalogTable({
	models,
	selectedId,
	onSelect,
	disabled,
}: ModelCatalogTableProps) {
	if (models.length === 0) {
		return (
			<div className="rounded-md border border-input border-dashed px-3 py-8 text-center text-muted-foreground text-sm">
				No models available. Connect a provider to see its models.
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-md border border-input">
			<table className="w-full caption-bottom text-sm">
				<tbody>
					{models.map((m) => {
						const preferred = m.id === selectedId;
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
													{m.name}
												</span>
												<CostBadge cost={m.cost_output} />
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
											className="cursor-pointer whitespace-nowrap rounded-md px-2 py-1 font-medium text-muted-foreground text-xs opacity-0 transition-opacity hover:bg-muted/40 hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed group-hover/row:opacity-100"
										>
											Set as preferred
										</button>
									)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
