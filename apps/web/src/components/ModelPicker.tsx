import { Popover } from "@base-ui-components/react/popover";
import { ChevronDown, Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import type { Model, ModelProvider } from "@/data/mock/types";
import { useModels } from "@/lib/hooks/useModels";
import { ModelRow } from "./ModelRow.js";
import { ProviderRail } from "./ProviderRail.js";
import { Button } from "./ui/button.js";

export function ModelPicker({ defaultModelId }: { defaultModelId: string }) {
	const { data: models } = useModels();
	const list = models ?? [];
	const initial = list.find((m) => m.id === defaultModelId) ?? list[0];
	const [selected, setSelected] = useState<Model>(initial);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	// null = "favorites / all" view (top-of-rail star).
	const [activeProvider, setActiveProvider] = useState<ModelProvider | null>(
		null,
	);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return list.filter((m) => {
			if (activeProvider !== null && m.provider !== activeProvider) {
				return false;
			}
			if (!q) return true;
			return (
				m.name.toLowerCase().includes(q) ||
				m.description.toLowerCase().includes(q) ||
				m.provider.toLowerCase().includes(q)
			);
		});
	}, [list, query, activeProvider]);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				render={
					<Button variant="chip" size="pill" aria-label="Select model">
						<span>{selected.name}</span>
						<ChevronDown className="h-4 w-4" aria-hidden />
					</Button>
				}
			/>
			<Popover.Portal>
				<Popover.Positioner side="top" align="start" sideOffset={8}>
					<Popover.Popup className="flex max-h-[480px] w-[720px] flex-col rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none">
						{/* Search row */}
						<div className="flex items-center gap-2 border-b border-input pb-2">
							<Search className="h-4 w-4 text-muted-foreground" aria-hidden />
							<input
								type="text"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search models…"
								className="h-9 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
							/>
							<Button variant="icon" size="icon" aria-label="Filter models">
								<SlidersHorizontal className="h-4 w-4" aria-hidden />
							</Button>
						</div>

						{/* Body */}
						<div className="mt-2 flex min-h-0 flex-1 flex-row gap-2">
							<ProviderRail
								activeProvider={activeProvider}
								onChange={setActiveProvider}
							/>

							{/* Model list */}
							<div className="flex-1 overflow-y-auto pr-1">
								{visible.length === 0 ? (
									<div className="px-3 py-6 text-center text-sm text-muted-foreground">
										No models match.
									</div>
								) : (
									<ul className="flex flex-col gap-0.5">
										{visible.map((m) => (
											<ModelRow
												key={m.id}
												model={m}
												isSelected={m.id === selected.id}
												onSelect={(picked) => {
													setSelected(picked);
													setOpen(false);
												}}
											/>
										))}
									</ul>
								)}
							</div>
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
