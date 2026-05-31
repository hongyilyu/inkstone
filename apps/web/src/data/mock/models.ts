import type { Model } from "./types.js";

export const models: Model[] = [
	{
		id: "gemma-3-27b",
		provider: "local",
		name: "gemma-3 27b",
		description:
			"Local sandbox model running through ollama. Fast, private, no quota.",
		tier: "$",
		capabilities: ["files"],
		favorite: true,
	},
	{
		id: "llama-3.3-70b",
		provider: "meta",
		name: "Llama 3.3 70B",
		description:
			"Meta's open-weight workhorse. Strong reasoning, broad tool use.",
		tier: "$",
		capabilities: ["reasoning", "files"],
	},
	{
		id: "claude-sonnet-4-6",
		provider: "anthropic",
		name: "Claude Sonnet 4.6",
		description:
			"Balanced Anthropic model. Great at code edits and long-context work.",
		tier: "$$",
		capabilities: ["vision", "reasoning", "files"],
		favorite: true,
	},
	{
		id: "claude-opus-4-7",
		provider: "anthropic",
		name: "Claude Opus 4.7",
		description:
			"Anthropic's flagship. Best for hard reasoning and architectural tasks.",
		tier: "$$$",
		capabilities: ["vision", "reasoning", "files"],
	},
	{
		id: "gpt-5",
		provider: "openai",
		name: "GPT-5",
		description:
			"OpenAI's general-purpose model. Solid across coding, writing, and search.",
		tier: "$$",
		capabilities: ["vision", "reasoning", "files"],
		favorite: true,
	},
	{
		id: "gpt-5-4-mini",
		provider: "openai",
		name: "GPT-5.4 mini",
		description:
			"Smaller, cheaper OpenAI tier — quick replies, light reasoning.",
		tier: "$",
		capabilities: ["vision", "files"],
	},
	{
		id: "gemini-2-5-pro",
		provider: "google",
		name: "Gemini 2.5 Pro",
		description:
			"Google's long-context model. Multimodal with strong document handling.",
		tier: "$$",
		capabilities: ["vision", "reasoning", "files"],
	},
	{
		id: "deepseek-v3",
		provider: "deepseek",
		name: "DeepSeek V3",
		description: "Open reasoning model with strong math and code benchmarks.",
		tier: "$",
		capabilities: ["reasoning", "files"],
	},
	{
		id: "kimi-k2",
		provider: "moonshot",
		name: "Kimi K2",
		description:
			"Moonshot's long-context model. Handles huge documents in one shot.",
		tier: "$$",
		capabilities: ["vision", "files"],
	},
];
