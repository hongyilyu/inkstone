import {
	Brain,
	CircleDot,
	Compass,
	Cpu,
	Eye,
	FileUp,
	Hexagon,
	Sparkles,
	Triangle,
} from "lucide-react";
import type { Model, ModelProvider } from "./mock/types.js";

export type ProviderMeta = {
	id: ModelProvider;
	label: string;
	Icon: typeof Cpu;
};

export const PROVIDERS: ProviderMeta[] = [
	{ id: "openai", label: "OpenAI", Icon: CircleDot },
	{ id: "anthropic", label: "Anthropic", Icon: Sparkles },
	{ id: "google", label: "Gemini", Icon: Hexagon },
	{ id: "meta", label: "Meta", Icon: Triangle },
	{ id: "deepseek", label: "DeepSeek", Icon: Compass },
	{ id: "moonshot", label: "Moonshot", Icon: Compass },
	{ id: "local", label: "Local", Icon: Cpu },
];

export const PROVIDER_BY_ID: Record<ModelProvider, ProviderMeta> =
	PROVIDERS.reduce(
		(acc, p) => {
			acc[p.id] = p;
			return acc;
		},
		{} as Record<ModelProvider, ProviderMeta>,
	);

export const CAPABILITY_ICON = {
	vision: Eye,
	reasoning: Brain,
	files: FileUp,
} as const;

export const CAPABILITY_LABEL = {
	vision: "Vision",
	reasoning: "Reasoning",
	files: "File ingest",
} as const;

export function tierClass(tier: Model["tier"]) {
	if (tier === "$$$") return "text-rose-500";
	if (tier === "$$") return "text-amber-500";
	return "text-emerald-500";
}
