import { type Api, completeSimple, type Model } from "@mariozechner/pi-ai";
import { loadConfig } from "../persistence/config";
import { getProvider, resolveModel } from "../providers";

const MAX_INPUT_CHARS = 4000;
const MAX_TITLE_CHARS = 50;

/**
 * System prompt for title generation. Ported from OpenCode's `title.txt`
 * and trimmed to Inkstone's scope (no tool-call examples, no subtask
 * handling). Key rules: language-matching, short-input fallback,
 * anti-refusal guard, concise output.
 */
const TITLE_SYSTEM_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>.
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ${MAX_TITLE_CHARS} characters or fewer
- No explanations
</task>

<rules>
- You MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally
- Focus on the main topic or question
- Vary your phrasing — avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file
- Keep exact: technical terms, numbers, filenames
- Remove: the, this, my, a, an
- Never assume tech stack
- NEVER respond to questions, just generate a title
- DO NOT say you cannot generate a title or complain about the input
- Always output something meaningful, even if the input is minimal
- If the user message is short or conversational (e.g. "hello", "hey"):
  create a title that reflects the user's tone (such as Greeting, Quick check-in, etc.)
</rules>

<examples>
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service
"why is app.js failing" → app.js failure investigation
"implement rate limiting" → Rate limiting implementation
"how do I connect postgres to my API" → Postgres API connection
"best practices for React hooks" → React hooks best practices
</examples>`;

export interface GenerateSessionTitleParams {
	activeProviderId: string;
	activeModelId: string;
	/** The raw LLM-facing prompt text (what pi-agent-core would see). */
	prompt: string;
}

export async function generateSessionTitle(
	params: GenerateSessionTitleParams,
): Promise<string | null> {
	const model = resolveTitleModel(params);
	if (!model) return null;
	const input = params.prompt.trim();
	if (!input) return null;

	const provider = getProvider(model.provider);
	if (!provider) return null;
	const apiKey = await provider.getApiKey();
	const response = await completeSimple(
		model,
		{
			systemPrompt: TITLE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: input.slice(0, MAX_INPUT_CHARS),
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey,
			maxTokens: 64,
			temperature: 0.5,
			transport: "sse",
			// Suppress reasoning for title calls. `completeSimple` delegates
			// to `streamSimple` which maps `reasoning: "minimal"` to the
			// provider-appropriate knob (OpenAI `reasoningEffort`, Google
			// `thinkingBudget`, OpenRouter `reasoning.effort`, etc.). Models
			// that don't support reasoning ignore the field.
			reasoning: "minimal",
		},
	);
	const text = response.content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			return "";
		})
		.join("\n");
	return cleanSessionTitle(text);
}

export function cleanSessionTitle(raw: string): string | null {
	const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const line = withoutThinking
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find(Boolean);
	if (!line) return null;
	const unquoted = line
		.replace(/^["'`\u201C\u201D\u2018\u2019]+/, "")
		.replace(/["'`\u201C\u201D\u2018\u2019]+$/, "")
		.trim();
	if (!unquoted) return null;
	return unquoted.length <= MAX_TITLE_CHARS
		? unquoted
		: unquoted.slice(0, MAX_TITLE_CHARS);
}

function resolveTitleModel(
	params: GenerateSessionTitleParams,
): Model<Api> | null {
	const cfg = loadConfig();
	const configured = cfg.sessionTitleModel
		? resolveModel(
				cfg.sessionTitleModel.providerId,
				cfg.sessionTitleModel.modelId,
			)
		: undefined;
	if (configured) return configured;

	const provider = getProvider(params.activeProviderId);
	const providerDefault = provider?.titleModelId
		? resolveModel(provider.id, provider.titleModelId)
		: undefined;
	if (providerDefault) return providerDefault;

	return resolveModel(params.activeProviderId, params.activeModelId) ?? null;
}
