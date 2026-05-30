import { Popover } from "@base-ui-components/react/popover";
import {
	Brain,
	ChevronDown,
	CircleDot,
	Compass,
	Cpu,
	Eye,
	FileUp,
	Hexagon,
	Info,
	Search,
	SlidersHorizontal,
	Sparkles,
	Star,
	Triangle,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
	type Model,
	type ModelProvider,
	models,
} from "../data/mock.js";
import { Button } from "./ui/button.js";

type ProviderMeta = { id: ModelProvider; label: string; Icon: typeof Cpu };

const PROVIDERS: ProviderMeta[] = [
	{ id: "openai", label: "OpenAI", Icon: CircleDot },
	{ id: "anthropic", label: "Anthropic", Icon: Sparkles },
	{ id: "google", label: "Gemini", Icon: Hexagon },
	{ id: "meta", label: "Meta", Icon: Triangle },
	{ id: "deepseek", label: "DeepSeek", Icon: Compass },
	{ id: "moonshot", label: "Moonshot", Icon: Compass },
	{ id: "local", label: "Local", Icon: Cpu },
];

const PROVIDER_BY_ID: Record<ModelProvider, ProviderMeta> = PROVIDERS.reduce(
	(acc, p) => {
		acc[p.id] = p;
		return acc;
	},
	{} as Record<ModelProvider, ProviderMeta>,
);

const CAPABILITY_ICON = {
	vision: Eye,
	reasoning: Brain,
	files: FileUp,
} as const;

const CAPABILITY_LABEL = {
	vision: "Vision",
	reasoning: "Reasoning",
	files: "File ingest",
} as const;

function tierClass(tier: Model["tier"]) {
	if (tier === "$$$") return "text-rose-500";
	if (tier === "$$") return "text-amber-500";
	return "text-emerald-500";
}

export function ModelPicker({
	defaultModelId,
}: {
	defaultModelId: string;
}) {
	const initial = models.find((m) => m.id === defaultModelId) ?? models[0];
	const [selected, setSelected] = useState<Model>(initial);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	// null = "favorites / all" view (top-of-rail star).
	const [activeProvider, setActiveProvider] = useState<ModelProvider | null>(
		null,
	);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return models.filter((m) => {
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
	}, [query, activeProvider]);

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
							<Search
								className="h-4 w-4 text-muted-foreground"
								aria-hidden
							/>
							<input
								type="text"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search models…"
								className="h-9 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
							/>
							<Button
								variant="icon"
								size="icon"
								aria-label="Filter models"
							>
								<SlidersHorizontal className="h-4 w-4" aria-hidden />
							</Button>
						</div>

						{/* Body */}
						<div className="mt-2 flex min-h-0 flex-1 flex-row gap-2">
							{/* Provider rail */}
							<div className="flex w-16 flex-col items-center gap-1">
								<button
									type="button"
									onClick={() => setActiveProvider(null)}
									aria-label="Favorites"
									aria-pressed={activeProvider === null}
									className={`flex h-10 w-10 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-accent-foreground ${
										activeProvider === null
											? "bg-accent text-accent-foreground"
											: ""
									}`}
								>
									<Star
										className="h-4 w-4 fill-current"
										aria-hidden
									/>
								</button>
								<div className="my-1 h-px w-8 bg-border" />
								{PROVIDERS.map(({ id, label, Icon }) => {
									const isActive = activeProvider === id;
									return (
										<button
											key={id}
											type="button"
											onClick={() => setActiveProvider(id)}
											aria-label={label}
											aria-pressed={isActive}
											className={`flex h-10 w-10 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-accent-foreground ${
												isActive
													? "bg-accent text-accent-foreground"
													: ""
											}`}
										>
											<Icon className="h-4 w-4" aria-hidden />
										</button>
									);
								})}
							</div>

							{/* Model list */}
							<div className="flex-1 overflow-y-auto pr-1">
								{visible.length === 0 ? (
									<div className="px-3 py-6 text-center text-sm text-muted-foreground">
										No models match.
									</div>
								) : (
									<ul className="flex flex-col gap-0.5">
										{visible.map((m) => {
											const ProviderIcon =
												PROVIDER_BY_ID[m.provider].Icon;
											const isSelected = m.id === selected.id;
											return (
												<li key={m.id}>
													<button
														type="button"
														onClick={() => {
															setSelected(m);
															setOpen(false);
														}}
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
																	{m.name}
																</span>
																<span
																	className={`text-xs font-semibold ${tierClass(m.tier)}`}
																	aria-label={`Tier ${m.tier}`}
																>
																	{m.tier}
																</span>
																{m.favorite ? (
																	<Star
																		className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400"
																		aria-label="Favorite"
																	/>
																) : null}
															</div>
															<p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
																{m.description}
															</p>
														</div>
														<div className="flex items-center gap-1 text-foreground/60">
															{m.capabilities.map((cap) => {
																const CapIcon = CAPABILITY_ICON[cap];
																return (
																	<span
																		key={cap}
																		className="flex h-6 w-6 items-center justify-center rounded-md"
																		title={CAPABILITY_LABEL[cap]}
																		aria-label={CAPABILITY_LABEL[cap]}
																	>
																		<CapIcon
																			className="h-3.5 w-3.5"
																			aria-hidden
																		/>
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
										})}
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
