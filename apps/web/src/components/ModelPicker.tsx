import { Popover } from "@base-ui-components/react/popover";
import type { ModelInfo } from "@inkstone/protocol";
import { Brain, Check, ChevronDown, Eye } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { filterEnabledModels } from "@/lib/enabledModels.js";
import { useProviderStatus } from "@/lib/hooks/useProviderStatus";
import { cn } from "@/lib/utils.js";
import { useRuntime } from "@/runtime";
import { fetchCatalog, fetchSettings, saveSettings } from "@/store/settings";
import { Button } from "./ui/button.js";
import { SearchField } from "./ui/search-field.js";

/** Composer model picker (ADR-0024). Reflects `model/catalog` and the preferred model (`settings/get`); picking one persists it via `settings/set`. */
export function ModelPicker() {
	const runtime = useRuntime();
	const [models, setModels] = useState<readonly ModelInfo[]>([]);
	// Which provider each model belongs to, from the catalog groups (ADR-0062) —
	// the flat `models` list loses the group, so keep the mapping to cross-ref the
	// provider's connected flag below.
	const [providerByModel, setProviderByModel] = useState<
		Record<string, string>
	>({});
	const [selectedId, setSelectedId] = useState<string | null>(null);
	// `null` until settings/get resolves; only then does the empty-vs-curated
	// distinction become meaningful. Keeping it null pre-load prevents the
	// transient "show all" flash a curated user would otherwise see in the gap
	// between the catalog and the settings resolving.
	const [enabledIds, setEnabledIds] = useState<readonly string[] | null>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");

	useEffect(() => {
		let alive = true;
		fetchCatalog(runtime)
			.then((c) => {
				if (!alive) return;
				setModels(c.providers.flatMap((p) => p.models));
				setProviderByModel(
					Object.fromEntries(
						c.providers.flatMap((p) => p.models.map((m) => [m.id, p.id])),
					),
				);
			})
			.catch(() => {});
		fetchSettings(runtime)
			.then((s) => {
				if (!alive) return;
				setSelectedId(s.model);
				setEnabledIds(s.enabled_models);
			})
			// On failure, clear the loading sentinel to the uncurated set ([]= show
			// all) rather than leaving it null forever — otherwise a settings/get
			// error would freeze the picker empty even after the catalog loads.
			.catch(() => {
				if (alive) setEnabledIds([]);
			});
		return () => {
			alive = false;
		};
	}, [runtime]);

	const selected = useMemo(
		() => models.find((m) => m.id === selectedId) ?? null,
		[models, selectedId],
	);

	// Which providers are connected (ADR-0062). A model whose provider has no
	// credential would run TOKENLESS and fail (Core now rejects such a send with a
	// typed -32004), so it is not OFFERED here at all — the picker lists only models
	// under a connected provider. The composer's `anyConnected` gate is too coarse
	// for a cross-provider picker (it passes as long as ANY provider is connected).
	const { data: providerStatus } = useProviderStatus();
	const connectedProviders = useMemo(
		() =>
			new Set(
				(providerStatus?.providers ?? [])
					.filter((p) => p.connected)
					.map((p) => p.id),
			),
		[providerStatus],
	);
	// Whether a model's provider is CONFIRMED connected. This must not fail open:
	// there IS a Core run-path guard now, but showing an unusable model still dead-
	// ends the send. Tri-state on status resolution — while status is unresolved
	// (`providerStatus === undefined`) a model with a KNOWN provider group is NOT
	// yet treated as connected (hidden until status confirms), rather than flashing
	// a model that can't be used. A model with no known provider group (shouldn't
	// happen) is kept defensively.
	const isModelConnected = useCallback(
		(id: string) => {
			const provider = providerByModel[id];
			if (provider === undefined) return true;
			if (providerStatus === undefined) return false;
			return connectedProviders.has(provider);
		},
		[providerByModel, providerStatus, connectedProviders],
	);

	// Drop a persisted selection whose provider is no longer connected (ADR-0062):
	// the credential can vanish out from under a stored default (e.g. the stale-
	// credential case), so ONCE STATUS RESOLVES, a selected model under a
	// disconnected provider is cleared to null — the trigger falls back to "Select
	// model" and the user must consciously re-pick from what's available, rather
	// than silently keeping a model that can't be used. Until status resolves (or if
	// it fails), the trigger still shows the stored selection optimistically; the
	// backstop is Core, which rejects a send to a disconnected provider with -32004.
	// Local-only: does NOT persist the clear (Core still owns the stored default).
	useEffect(() => {
		if (providerStatus === undefined || selectedId === null) return;
		if (!isModelConnected(selectedId)) setSelectedId(null);
	}, [providerStatus, selectedId, isModelConnected]);

	// Scope the catalog to the user's enabled set (ADR-0024), THEN to connected
	// providers (ADR-0062). Until settings load (`enabledIds === null`) show nothing
	// — a curated user must never see a disabled model, even for one frame. Once
	// loaded, an empty `enabled_models` means "no curation → show all" (matches
	// Core's unset→full-catalog default); a non-empty set lists only those ids. The
	// connected filter then hides any model whose provider isn't wired up.
	const enabled = useMemo(() => {
		if (enabledIds === null) return [];
		return filterEnabledModels(models, enabledIds).filter((m) =>
			isModelConnected(m.id),
		);
	}, [models, enabledIds, isModelConnected]);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return enabled;
		return enabled.filter(
			(m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
		);
	}, [enabled, query]);

	const pick = (id: string) => {
		setSelectedId(id); // optimistic
		setOpen(false);
		saveSettings(runtime, { model: id })
			.then((s) => setSelectedId(s.model))
			.catch(() => {});
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				render={
					<Button variant="chip" size="pill" aria-label="Select model">
						<span>{selected?.name ?? "Select model"}</span>
						<ChevronDown className="h-4 w-4" aria-hidden />
					</Button>
				}
			/>
			<Popover.Portal>
				<Popover.Positioner side="top" align="start" sideOffset={8}>
					<Popover.Popup className="flex max-h-[420px] w-[360px] flex-col rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg outline-none">
						<SearchField
							variant="divider"
							wrapperClassName="px-2"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search models…"
						/>
						<ul className="mt-1 flex flex-col gap-0.5 overflow-y-auto pr-1">
							{visible.length === 0 ? (
								<li className="px-3 py-6 text-center text-muted-foreground text-sm">
									{query.trim()
										? "No models available."
										: "No models available. Connect a provider in Settings."}
								</li>
							) : (
								visible.map((m) => {
									const isSel = m.id === selectedId;
									// Only connected-provider models are listed (filtered above),
									// so every row here is selectable — no lock/disabled state.
									return (
										<li key={m.id}>
											<button
												type="button"
												onClick={() => pick(m.id)}
												className={cn(
													"flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent",
													isSel && "bg-accent/60",
												)}
											>
												<Brain
													className="size-4 shrink-0 text-foreground/70"
													aria-hidden
												/>
												<span className="min-w-0 flex-1 truncate font-medium text-sm">
													{m.name}
												</span>
												{m.input.includes("image") ? (
													<Eye
														className="size-3.5 shrink-0 text-muted-foreground"
														aria-label="Vision"
													/>
												) : null}
												{isSel ? (
													<Check
														className="size-4 shrink-0 text-primary"
														aria-label="Selected"
													/>
												) : null}
											</button>
										</li>
									);
								})
							)}
						</ul>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
