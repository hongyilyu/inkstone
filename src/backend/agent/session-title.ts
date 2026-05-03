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
	const primary = resolveTitleModel(params);
	if (!primary) return null;
	const input = params.prompt.trim();
	if (!input) return null;

	// Primary attempt. Wrap in try/catch so a provider error (model
	// unavailable on the user's plan, auth blip, transient 5xx) doesn't
	// silently poison the title. We only retry on throws, not on
	// `cleanSessionTitle` returning `null` — a successful call that
	// produced empty text is a valid "no title" signal (e.g. safety
	// filter, refused short input), and retrying on the chat model
	// would just burn tokens for the same answer.
	try {
		const raw = await runTitleCompletion(primary, input);
		return cleanSessionTitle(raw);
	} catch (err) {
		console.error(
			`[inkstone] session title generation failed (model: ${primary.provider}/${primary.id}):`,
			err,
		);
	}

	// Retry onto the active chat model. Guaranteed available — the user
	// just successfully prompted with it one millisecond earlier. Skip
	// when the primary attempt already used this model (avoids a
	// pointless duplicate request that would fail identically). The
	// guard compares (provider, id) rather than id alone so a
	// `config.sessionTitleModel` override on a different provider that
	// happens to share the chat model's id still retries correctly.
	if (
		primary.provider === params.activeProviderId &&
		primary.id === params.activeModelId
	) {
		return null;
	}
	const fallback = resolveModel(params.activeProviderId, params.activeModelId);
	if (!fallback) return null;

	try {
		const raw = await runTitleCompletion(fallback, input);
		return cleanSessionTitle(raw);
	} catch (err) {
		console.error(
			`[inkstone] session title retry also failed (model: ${fallback.provider}/${fallback.id}):`,
			err,
		);
		return null;
	}
}

/**
 * Shared request body for title generation. Resolves the api key from
 * `model.provider`'s registry entry internally so the primary and retry
 * paths stay one-liners at the call site — both share the same
 * "provider lookup → key fetch → request" shape.
 *
 * Non-null assertion on `getProvider(model.provider)`: every `Model<Api>`
 * reaching this function flowed through `resolveModel` or
 * `resolveTitleModel`, which call `getProvider(providerId).listModels()`
 * to construct the returned model. So the provider is known to the
 * registry by construction — reaching here with an unknown provider
 * would require hand-building a `Model<Api>` outside that path, which
 * no current caller does. The `!` documents the invariant; changing it
 * to a guarded if would imply a recovery branch that can't fire.
 *
 * Content-block filter: we only fold `type: "text"` blocks into the
 * raw title. Structured `type: "thinking"` blocks are the native
 * Anthropic/reasoning-model shape — concatenating them here used to
 * pollute titles with reasoning preambles (observed: Kiro Claude
 * Haiku 4.5 emitted "The user is asking me to generate a thread
 * title f" as the first 50 chars of its thinking preamble, which
 * became the stored title). pi-ai already typed them separately so
 * consumers can filter; we do. The `<think>...</think>` regex in
 * `cleanSessionTitle` is the orthogonal seam for pseudo-XML thinking
 * disguised inside text blocks (some OpenRouter / local models).
 * `reasoning: "minimal"` below is a request-side hint; providers
 * don't uniformly honor it for Anthropic thinking, so the content
 * filter here is the hard guarantee.
 *
 * Any change (e.g. `maxTokens`, `reasoning` level) applies to both the
 * primary and retry requests.
 */
async function runTitleCompletion(
	model: Model<Api>,
	input: string,
): Promise<string> {
	// biome-ignore lint/style/noNonNullAssertion: model.provider is guaranteed in PROVIDERS because every caller obtains `model` via `resolveModel`/`resolveTitleModel`, which already round-tripped through `getProvider`. See the function docstring for the full invariant.
	const provider = getProvider(model.provider)!;
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
			// No `temperature` field. pi-ai's Codex provider
			// (`openai-codex-responses.js:buildRequestBody`) forwards
			// `temperature` into the OpenAI Responses request body
			// unconditionally, and every Codex model Inkstone ships
			// with (`gpt-5.4-mini`, `gpt-5.4`, `gpt-5.5`, …) is a
			// reasoning model whose endpoint rejects non-default
			// `temperature` with a 400 "Unsupported parameter". On a
			// Codex-only user that 400 fires on both the primary
			// (`titleModelId`) hop and the `activeModelId` retry hop
			// (both are reasoning models), so the whole task silently
			// returns null and the session keeps its
			// `"New session - <ISO>"` default forever. Omitting the
			// field lets each provider use its default; title quality
			// is dominated by the system prompt + examples, not
			// temperature jitter. The main chat path already sends
			// no temperature (only this file did), which is why chat
			// worked while titles didn't.
			transport: "sse",
			// Suppress reasoning for title calls. `completeSimple` delegates
			// to `streamSimple` which maps `reasoning: "minimal"` to the
			// provider-appropriate knob (OpenAI `reasoningEffort`, Google
			// `thinkingBudget`, OpenRouter `reasoning.effort`, etc.). Models
			// that don't support reasoning ignore the field. Not a hard
			// guarantee — see the content-block filter above.
			reasoning: "minimal",
		},
	);
	return response.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
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
