import { availableThinkingLevels } from "@backend/agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createMemo } from "solid-js";
import type { DialogContext } from "../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select";

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
 * Variant (reasoning effort) picker.
 *
 * Shown as the second step of a model-selection cascade when the just-picked
 * model has `model.reasoning === true`. For non-reasoning models the picker
 * skips this dialog entirely. Mirrors OpenCode's `DialogVariant`
 * (`cli/cmd/tui/component/dialog-variant.tsx`) trimmed to pi-ai's unified
 * `ThinkingLevel` enum so Inkstone doesn't need OpenCode's per-SDK `variants()`
 * switch — pi-ai owns the provider-specific mapping internally.
 */
export function DialogVariant(props: {
	model: Model<Api>;
	current: ThinkingLevel;
	onSelect: (level: ThinkingLevel) => void;
}) {
	const options = createMemo<DialogSelectOption<ThinkingLevel>[]>(() =>
		availableThinkingLevels(props.model).map((level) => ({
			title: LEVEL_LABELS[level],
			value: level,
			description: LEVEL_DESCRIPTIONS[level],
		})),
	);

	return (
		<DialogSelect
			title={`Reasoning effort — ${props.model.name}`}
			placeholder="Search efforts..."
			options={options()}
			current={props.current}
			onSelect={(option) => props.onSelect(option.value)}
		/>
	);
}

DialogVariant.show = (
	dialog: DialogContext,
	model: Model<Api>,
	current: ThinkingLevel,
	onSelect: (level: ThinkingLevel) => void,
) => {
	dialog.replace(() => (
		<DialogVariant model={model} current={current} onSelect={onSelect} />
	));
};
