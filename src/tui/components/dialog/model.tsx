import { loadConfig } from "@backend/persistence/config";
import { getProvider, listProviders, resolveModel } from "@backend/providers";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createMemo } from "solid-js";
import type { DialogContext } from "../../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select";

type AnyModel = Model<Api>;

/**
 * Tagged value attached to each `DialogSelectOption`. The "Use default"
 * row carries `{ kind: "clear" }`; per-model rows carry
 * `{ kind: "set", providerId, modelId }`. `DialogSelect`'s `current`
 * prop uses `isDeepEqual` (remeda) so the clear-row's `●` indicator
 * compares cleanly when the active agent has no override.
 *
 * Pattern mirrors `DialogMiniModel` (the `/mini-model` picker), which
 * shipped with this exact shape for `config.sessionTitleModel`. Using
 * the same shape keeps both pickers' clear-row UX identical from a
 * user-visible standpoint.
 */
type ModelValue =
	| { kind: "clear" }
	| { kind: "set"; providerId: string; modelId: string };

/**
 * Flat model picker.
 *
 * Lists models from every *connected* provider. Disconnected providers are
 * hidden — use the Connect dialog to set credentials and make them appear.
 * Options carry `category: provider.displayName`; DialogSelect renders that
 * as a group header over the per-provider run, so the description column
 * is left empty (the provider name would otherwise duplicate the header
 * on every row).
 *
 * "Use default" row: only rendered when the active agent has a per-agent
 * `model` override (`config.agents.<agentName>.model`). Selecting it
 * routes through `props.onClear`, which removes the override so the
 * agent re-inherits from `config.model`. Without the row, the only
 * way to undo a per-agent pick is to hand-edit `config.json`.
 *
 * The label resolves the top-level fallback at dialog-open time so the
 * row reads "Use default (Provider: Model)" rather than the abstract
 * "Use default" — same affordance as `DialogMiniModel`.
 */
export function DialogModel(props: {
	/**
	 * Currently-active (provider, model) pair. Used by `DialogSelect`'s
	 * `current` matching to render the `●` indicator on the right row.
	 */
	current: { providerId: string; modelId: string };
	/** Active agent name — keys the per-agent override lookup. */
	agentName: string;
	onSelect: (model: AnyModel) => void;
	/** Called when the user picks "Use default". Optional — call sites
	 * that don't want to expose the clear affordance (none today) can
	 * omit it; the row is also hidden when there is no override to
	 * clear. */
	onClear?: () => void;
}) {
	const connectedProviders = createMemo(() =>
		listProviders().filter((p) => p.isConnected()),
	);

	// Snapshot at component construction. The dialog stack remounts on
	// every `dialog.replace(...)`, so each open re-evaluates `cfg`; a
	// concurrent `saveConfig` write inside this same dialog instance
	// (none today — the dialog only reads config, doesn't write) would
	// not be observed. Mirrors `DialogMiniModel`'s pattern.
	const cfg = loadConfig();
	const hasOverride = !!cfg.agents?.[props.agentName]?.model;
	const topLevel = cfg.model;
	const defaultLabel = topLevel
		? (() => {
				const provider = getProvider(topLevel.providerId);
				const m = resolveModel(topLevel.providerId, topLevel.modelId);
				const providerLabel = provider?.displayName ?? topLevel.providerId;
				const modelLabel = m?.name ?? topLevel.modelId;
				return `${providerLabel}: ${modelLabel}`;
			})()
		: "first connected provider's default";

	// `current` always points at the active (provider, model) `{ kind:
	// "set", ... }` value, regardless of whether the agent has an
	// override. `DialogSelect` uses `isDeepEqual` to find the matching
	// option for the `●` indicator; the clear-row's `{ kind: "clear" }`
	// value never deep-equals a "set" current, so it stays unmarked
	// even when an override exists. Setting `current` to "clear" here
	// would suppress the indicator entirely when the agent has no
	// override (the clear-row is hidden, but no other row matches).
	const current: ModelValue = {
		kind: "set",
		providerId: props.current.providerId,
		modelId: props.current.modelId,
	};

	const options = createMemo<DialogSelectOption<ModelValue>[]>(() => {
		const modelRows: DialogSelectOption<ModelValue>[] =
			connectedProviders().flatMap((provider) =>
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
		const rows: DialogSelectOption<ModelValue>[] = [];
		// Only render the clear-row when there's something to clear AND
		// the call site provided an `onClear` handler. A clear-row with
		// no handler would be a dead UI element.
		if (hasOverride && props.onClear) {
			rows.push({
				title: `Use default (${defaultLabel})`,
				value: { kind: "clear" },
			});
		}
		rows.push(...modelRows);
		return rows;
	});

	return (
		<DialogSelect
			title="Select Model"
			placeholder={
				connectedProviders().length === 0
					? "No providers connected — use Connect to set credentials"
					: "Search models..."
			}
			options={options()}
			current={current}
			onSelect={(option) => {
				if (option.value.kind === "clear") {
					props.onClear?.();
					return;
				}
				const { providerId, modelId } = option.value;
				const provider = getProvider(providerId);
				if (!provider) return;
				const model = provider.listModels().find((m) => m.id === modelId);
				if (model) props.onSelect(model);
			}}
		/>
	);
}

DialogModel.show = (
	dialog: DialogContext,
	args: {
		current: { providerId: string; modelId: string };
		agentName: string;
		onSelect: (model: AnyModel) => void;
		onClear?: () => void;
	},
) => {
	dialog.replace(() => (
		<DialogModel
			current={args.current}
			agentName={args.agentName}
			onSelect={args.onSelect}
			onClear={args.onClear}
		/>
	));
};
