import { loadConfig, saveConfig } from "@backend/persistence/config";
import { getProvider, listProviders } from "@backend/providers";
import { createMemo } from "solid-js";
import { type DialogContext, useDialog } from "../../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select";
import { useToast } from "../../ui/toast";

/**
 * Tagged value attached to each `DialogSelectOption`. The clear-row
 * gets `{ kind: "clear" }`; per-model rows get `{ kind: "set", ... }`.
 * `DialogSelect`'s `current` prop uses `isDeepEqual` (remeda) so the
 * clear-row's `●` indicator compares cleanly against the same shape
 * when no override is configured.
 */
type MiniModelValue =
	| { kind: "clear" }
	| { kind: "set"; providerId: string; modelId: string };

/**
 * `/mini-model` — pick the small/cheap model used for background
 * session title generation (and future background work).
 *
 * Writes through to `config.sessionTitleModel` in
 * `~/.config/inkstone/config.json`. Reading precedence is owned by
 * `resolveTitleModel` in `backend/agent/session-title.ts`:
 *
 *   config.sessionTitleModel  →  provider.titleModelId  →  active chat model
 *
 * So this dialog writes the *top* hop; clearing the override falls
 * back to the middle hop (the active provider's built-in
 * `titleModelId`), which falls back to the bottom hop.
 *
 * The clear-row is load-bearing — without it, the only way to undo an
 * override is to hand-edit `config.json`. The row label annotates the
 * resolved provider default at dialog-open time so the user sees what
 * they'd be falling back to.
 *
 * Disconnected-override handling: if `cfg.sessionTitleModel` points at
 * a provider that is currently disconnected, the override still lives
 * in `config.json` but `resolveTitleModel` can't honor it at runtime
 * (the model won't resolve through `listModels()` which returns `[]`
 * for disconnected providers, so precedence falls through). To keep
 * the UI truthful, we surface the stale override as an inline row
 * with a `(disconnected)` suffix so the user can see what's stored
 * and choose between "reconnect the provider" (out of this dialog)
 * or "clear the override" (pick any row here, including the
 * clear-row).
 *
 * Model list shows every connected provider's full catalog (same shape
 * as `DialogModel`). No filtering to "mini-looking" models — user's
 * call if they want `gpt-5.5` to do their titles. Naming + description
 * signal intent; enforcement via regex would be paternalistic and
 * would need upkeep as providers rename models.
 */
export function DialogMiniModel(props: {
	/** Active provider id at dialog-open time, used to compute the
	 * clear-row's resolved-default label. */
	activeProviderId: string;
	/** Active chat model id, consulted for the clear-row label when the
	 * active provider has no `titleModelId`. Matches
	 * `resolveTitleModel`'s last fallback. */
	activeModelId: string;
}) {
	const dialog = useDialog();
	const toast = useToast();

	const cfg = loadConfig();
	const current: MiniModelValue = cfg.sessionTitleModel
		? {
				kind: "set",
				providerId: cfg.sessionTitleModel.providerId,
				modelId: cfg.sessionTitleModel.modelId,
			}
		: { kind: "clear" };

	// Resolve what "provider default" concretely means right now, so
	// the clear-row label isn't abstract. Mirrors `resolveTitleModel`'s
	// logic on the non-override branch: provider's `titleModelId`
	// first, active chat model as last resort.
	const activeProvider = getProvider(props.activeProviderId);
	const resolvedDefaultModelId =
		activeProvider?.titleModelId ?? props.activeModelId;
	const defaultLabel = activeProvider
		? `${activeProvider.displayName}: ${resolvedDefaultModelId}`
		: resolvedDefaultModelId;

	const options = createMemo<DialogSelectOption<MiniModelValue>[]>(() => {
		const connected = listProviders().filter((p) => p.isConnected());
		const modelRows: DialogSelectOption<MiniModelValue>[] = connected.flatMap(
			(provider) =>
				provider.listModels().map((m) => ({
					title: m.name,
					value: {
						kind: "set" as const,
						providerId: provider.id,
						modelId: m.id,
					},
					category: provider.displayName,
				})),
		);

		// Disconnected-override surfacing: if the stored override
		// points at a provider that is currently not connected, the
		// override's row won't appear in the per-provider catalog
		// above. Without the explicit row, the `●` indicator (which
		// `DialogSelect` places via `current` matching) has nowhere to
		// land and the user sees no trace of their stored state. Emit
		// a single pinned row with `(disconnected)` so the stored
		// value is visible and pickable (picking it re-writes the
		// same value — idempotent no-op; the user's real affordance
		// here is the clear-row).
		let stalePinned: DialogSelectOption<MiniModelValue> | null = null;
		if (cfg.sessionTitleModel) {
			const overrideProvider = getProvider(cfg.sessionTitleModel.providerId);
			const overrideConnected = overrideProvider?.isConnected() ?? false;
			const overrideResolvable =
				overrideConnected &&
				overrideProvider
					?.listModels()
					.some((m) => m.id === cfg.sessionTitleModel?.modelId);
			if (!overrideResolvable) {
				const providerLabel =
					overrideProvider?.displayName ?? cfg.sessionTitleModel.providerId;
				stalePinned = {
					title: `${providerLabel}: ${cfg.sessionTitleModel.modelId} (disconnected)`,
					value: {
						kind: "set" as const,
						providerId: cfg.sessionTitleModel.providerId,
						modelId: cfg.sessionTitleModel.modelId,
					},
				};
			}
		}

		// Clear-row: no `description` so the full title renders without
		// flex-share truncation. The resolved default label is baked
		// into the title itself — a user scanning the list sees the
		// provider + model name inline, which is the signal they need
		// to understand "what falls back to what."
		const rows: DialogSelectOption<MiniModelValue>[] = [
			{
				title: `Use provider default (${defaultLabel})`,
				value: { kind: "clear" },
			},
		];
		if (stalePinned) rows.push(stalePinned);
		rows.push(...modelRows);
		return rows;
	});

	return (
		<DialogSelect
			title="Mini Model"
			placeholder="Search models..."
			options={options()}
			current={current}
			onSelect={(option) => {
				const value = option.value;
				if (value.kind === "clear") {
					// Gate the success toast on `saveConfig`'s return. On
					// failure (disk full, permission denied, invalid
					// shape) `saveConfig` returns `false` and has
					// already surfaced a persistence-error toast via
					// `reportPersistenceError` → `AgentProvider`. Firing
					// our own success toast on top would falsely confirm
					// the save to the user.
					const ok = saveConfig({ sessionTitleModel: undefined });
					if (ok) {
						toast.show({
							variant: "success",
							message: `Mini model: provider default (${defaultLabel})`,
							duration: 3000,
						});
					}
					dialog.clear();
					return;
				}
				const ok = saveConfig({
					sessionTitleModel: {
						providerId: value.providerId,
						modelId: value.modelId,
					},
				});
				if (ok) {
					const provider = getProvider(value.providerId);
					const providerLabel = provider?.displayName ?? value.providerId;
					toast.show({
						variant: "success",
						message: `Mini model for ${providerLabel}: ${value.modelId}`,
						duration: 3000,
					});
				}
				dialog.clear();
			}}
		/>
	);
}

DialogMiniModel.show = (
	dialog: DialogContext,
	activeProviderId: string,
	activeModelId: string,
) => {
	dialog.replace(() => (
		<DialogMiniModel
			activeProviderId={activeProviderId}
			activeModelId={activeModelId}
		/>
	));
};
