import { Star } from "lucide-react";
import type { ModelProvider } from "@/data/mock/types";
import { PROVIDERS } from "@/data/models-meta";

export function ProviderRail({
	activeProvider,
	onChange,
}: {
	activeProvider: ModelProvider | null;
	onChange: (p: ModelProvider | null) => void;
}) {
	return (
		<div className="flex w-16 flex-col items-center gap-1">
			<button
				type="button"
				onClick={() => onChange(null)}
				aria-label="Favorites"
				aria-pressed={activeProvider === null}
				className={`flex h-10 w-10 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-accent-foreground ${
					activeProvider === null ? "bg-accent text-accent-foreground" : ""
				}`}
			>
				<Star className="h-4 w-4 fill-current" aria-hidden />
			</button>
			<div className="my-1 h-px w-8 bg-border" />
			{PROVIDERS.map(({ id, label, Icon }) => {
				const isActive = activeProvider === id;
				return (
					<button
						key={id}
						type="button"
						onClick={() => onChange(id)}
						aria-label={label}
						aria-pressed={isActive}
						className={`flex h-10 w-10 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-accent-foreground ${
							isActive ? "bg-accent text-accent-foreground" : ""
						}`}
					>
						<Icon className="h-4 w-4" aria-hidden />
					</button>
				);
			})}
		</div>
	);
}
