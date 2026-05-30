import { Info, Star } from "lucide-react";
import type { Model } from "@/data/mock/types";
import {
	CAPABILITY_ICON,
	CAPABILITY_LABEL,
	PROVIDER_BY_ID,
	tierClass,
} from "@/data/models-meta";

export function ModelRow({
	model,
	isSelected,
	onSelect,
}: {
	model: Model;
	isSelected: boolean;
	onSelect: (m: Model) => void;
}) {
	const ProviderIcon = PROVIDER_BY_ID[model.provider].Icon;
	return (
		<li>
			<button
				type="button"
				onClick={() => onSelect(model)}
				className={`group flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors hover:bg-accent ${
					isSelected ? "bg-accent/60" : ""
				}`}
			>
				<ProviderIcon
					className="mt-0.5 h-6 w-6 shrink-0 text-foreground/70"
					aria-hidden
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate text-sm font-medium text-foreground">
							{model.name}
						</span>
						<span
							className={`text-xs font-semibold ${tierClass(model.tier)}`}
							aria-label={`Tier ${model.tier}`}
						>
							{model.tier}
						</span>
						{model.favorite ? (
							<Star
								className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400"
								aria-label="Favorite"
							/>
						) : null}
					</div>
					<p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
						{model.description}
					</p>
				</div>
				<div className="flex items-center gap-1 text-foreground/60">
					{model.capabilities.map((cap) => {
						const CapIcon = CAPABILITY_ICON[cap];
						return (
							<span
								key={cap}
								className="flex h-6 w-6 items-center justify-center rounded-md"
								title={CAPABILITY_LABEL[cap]}
								aria-label={CAPABILITY_LABEL[cap]}
							>
								<CapIcon className="h-3.5 w-3.5" aria-hidden />
							</span>
						);
					})}
					<span
						className="ml-1 flex h-6 w-6 items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100"
						aria-hidden
					>
						<Info className="h-3.5 w-3.5" />
					</span>
				</div>
			</button>
		</li>
	);
}
