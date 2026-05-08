import { availableThinkingLevels } from "@backend/agent";
import { loadConfig } from "@backend/persistence/config";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createMemo } from "solid-js";
import type { DialogContext } from "../../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select";

/**
 * Display labels + short descriptions per ThinkingLevel. The descriptions
 * mirror pi-mono/coding-agent's `THINKING_DESCRIPTIONS` (token counts refer
 * to Anthropic's budget defaults from pi-ai's `ThinkingBudgets` — accurate
 * for Bedrock/Claude, illustrative for other providers).
 */
const LEVEL_LABELS: Record<ThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
};

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
};

/**
 * Same tagged-value shape as `DialogModel`'s clear-row pattern:
 * `{ kind: "clear" }` for the synthetic top entry, `{ kind: "set",
 * level }` for each effort row. Lets `DialogSelect`'s `current` match
 * the clear-row when there is no per-agent override for the active
 * (provider, model) key.
 */
type VariantValue = { kind: "clear" } | { kind: "set"; level: ThinkingLevel };

/**
 * Variant (reasoning effort) picker.
 *
 * Shown as the second step of a model-selection cascade when the just-picked
 * model has `model.reasoning === true`. For non-reasoning models the picker
 * skips this dialog entirely. Mirrors OpenCode's `DialogVariant`
 * (`cli/cmd/tui/component/dialog-variant.tsx`) trimmed to pi-ai's unified
 * `ThinkingLevel` enum so Inkstone doesn't need OpenCode's per-SDK `variants()`
 * switch — pi-ai owns the provider-specific mapping internally.
 *
 * "Use default" row: only rendered when the active agent has a per-agent
 * thinking-level override for the active (provider, model) key. Selecting
 * it routes through `props.onClear`, which removes that single key from
 * the agent's `thinkingLevels` map. Other (provider, model) entries the
 * agent has set are preserved.
 */
export function DialogVariant(props: {
	model: Model<Api>;
	current: ThinkingLevel;
	/** Active agent name — keys the per-agent override lookup. */
	agentName: string;
	onSelect: (level: ThinkingLevel) => void;
	onClear?: () => void;
}) {
	// Snapshot at component construction; same remount-on-replace
	// invariant as `DialogModel` (see comment there).
	const cfg = loadConfig();
	const overrideKey = `${props.model.provider}/${props.model.id}`;
	const hasOverride =
		cfg.agents?.[props.agentName]?.thinkingLevels?.[overrideKey] !== undefined;
	const topLevelLevel: ThinkingLevel =
		cfg.thinkingLevels?.[overrideKey] ?? "off";

	const options = createMemo<DialogSelectOption<VariantValue>[]>(() => {
		const rows: DialogSelectOption<VariantValue>[] = [];
		if (hasOverride && props.onClear) {
			rows.push({
				title: `Use default (${LEVEL_LABELS[topLevelLevel]})`,
				value: { kind: "clear" },
			});
		}
		for (const level of availableThinkingLevels(props.model)) {
			rows.push({
				title: LEVEL_LABELS[level],
				value: { kind: "set", level },
				description: LEVEL_DESCRIPTIONS[level],
			});
		}
		return rows;
	});

	// `current` always points at the active level `{ kind: "set", ... }`
	// regardless of override state. Same rationale as `DialogModel`:
	// `{ kind: "clear" }` never matches a "set" option via `isDeepEqual`,
	// so the clear-row stays unmarked even when an override exists; and
	// when there's no override, the clear-row isn't rendered at all,
	// leaving the active level row as the only candidate for the `●`
	// indicator.
	const current: VariantValue = { kind: "set", level: props.current };

	return (
		<DialogSelect
			title={`Reasoning effort — ${props.model.name}`}
			placeholder="Search efforts..."
			options={options()}
			current={current}
			onSelect={(option) => {
				if (option.value.kind === "clear") {
					props.onClear?.();
					return;
				}
				props.onSelect(option.value.level);
			}}
		/>
	);
}

DialogVariant.show = (
	dialog: DialogContext,
	args: {
		model: Model<Api>;
		current: ThinkingLevel;
		agentName: string;
		onSelect: (level: ThinkingLevel) => void;
		onClear?: () => void;
	},
) => {
	dialog.replace(() => (
		<DialogVariant
			model={args.model}
			current={args.current}
			agentName={args.agentName}
			onSelect={args.onSelect}
			onClear={args.onClear}
		/>
	));
};
