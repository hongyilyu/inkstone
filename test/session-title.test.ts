import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config } from "@backend/persistence/schema";
import {
	appendDisplayMessage,
	createDefaultTitle,
	createSession,
	listSessions,
	loadSession,
	newId,
	runInTransaction,
	updateSessionTitle,
} from "@backend/persistence/sessions";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { cleanSessionTitle } from "../src/backend/agent/session-title";
import { CONFIG_HOME } from "./preload";

// ────────────────────────────────────────────────────────────────────
// Mocked `completeSimple` — scriptable per-test via `completeSimpleMock`.
//
// `mock.module` must run BEFORE `generateSessionTitle` is imported so
// its static `import { completeSimple } from "@mariozechner/pi-ai"`
// resolves to the mocked function. The real pi-ai module is preserved
// on the spread so other exports (`getModels`, etc.) still work — the
// openrouter provider resolves models through `getModels` and we don't
// want to break that. Pinned to `@mariozechner/pi-ai` only; the
// provider module's `openai-codex` path is untouched.
// ────────────────────────────────────────────────────────────────────

type CompleteSimpleFn = (
	model: { id: string; provider: string },
	context: unknown,
	options: unknown,
) => Promise<AssistantMessage>;

let completeSimpleMock: CompleteSimpleFn = async () => {
	throw new Error("completeSimpleMock not configured");
};
const completeSimpleCalls: {
	modelId: string;
	provider: string;
	apiKey: unknown;
}[] = [];

const realPiAi = await import("@mariozechner/pi-ai");
mock.module("@mariozechner/pi-ai", () => ({
	...realPiAi,
	completeSimple: async (
		model: { id: string; provider: string },
		context: unknown,
		options: unknown,
	) => {
		completeSimpleCalls.push({
			modelId: model.id,
			provider: model.provider,
			apiKey: (options as { apiKey?: unknown } | undefined)?.apiKey,
		});
		return completeSimpleMock(model, context, options);
	},
}));

// Import after the mock so the static `completeSimple` binding inside
// `session-title.ts` is the mocked one.
const { generateSessionTitle } = await import(
	"../src/backend/agent/session-title"
);

function makeAssistantReply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "mock",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("session titles", () => {
	test("createSession initializes title to a human-readable default", () => {
		const rec = createSession({ agent: "reader" });
		expect(rec.title).toMatch(/^New session - \d{4}-\d{2}-\d{2}T/);

		const loaded = loadSession(rec.id);
		expect(loaded?.session.title).toBe(rec.title);
	});

	test("createDefaultTitle produces ISO-timestamped string", () => {
		const ts = new Date("2026-05-02T12:00:00.000Z").getTime();
		expect(createDefaultTitle(ts)).toBe(
			"New session - 2026-05-02T12:00:00.000Z",
		);
	});

	test("updateSessionTitle replaces the stored session title", () => {
		const rec = createSession({ agent: "reader" });

		runInTransaction((tx) => updateSessionTitle(tx, rec.id, "Reading Notes"));

		const loaded = loadSession(rec.id);
		expect(loaded?.session.title).toBe("Reading Notes");
	});

	test("listSessions returns title and still computes preview", () => {
		const rec = createSession({ agent: "reader" });
		runInTransaction((tx) => {
			appendDisplayMessage(tx, rec.id, {
				id: newId(),
				role: "user",
				parts: [{ type: "text", text: "first user preview" }],
			});
			updateSessionTitle(tx, rec.id, "Generated Title");
		});

		const row = listSessions().find((s) => s.id === rec.id);
		expect(row?.title).toBe("Generated Title");
		expect(row?.preview).toBe("first user preview");
	});

	test("cleans generated title output", () => {
		expect(cleanSessionTitle('"Useful title"\nextra')).toBe("Useful title");
		expect(cleanSessionTitle("<think>hidden</think>\nVisible")).toBe("Visible");
		expect(cleanSessionTitle("\n\n")).toBeNull();
		expect(cleanSessionTitle("a".repeat(60))).toBe("a".repeat(50));
	});

	test("config schema validates sessionTitleModel shape", () => {
		expect(
			Config.safeParse({
				sessionTitleModel: { providerId: "openrouter", modelId: "kimi" },
			}).success,
		).toBe(true);
		expect(
			Config.safeParse({
				sessionTitleModel: { providerId: "", modelId: "kimi" },
			}).success,
		).toBe(false);
		expect(
			Config.safeParse({
				sessionTitleModel: { providerId: "openrouter" },
			}).success,
		).toBe(false);
	});
});

describe("generateSessionTitle retry-on-throw", () => {
	beforeEach(() => {
		completeSimpleCalls.length = 0;
		completeSimpleMock = async () => {
			throw new Error("completeSimpleMock not configured");
		};
	});

	test("primary model throws → retries on active chat model → title", async () => {
		// OpenRouter's `titleModelId` is `moonshotai/kimi-k2.6`; we use
		// a different id as the "active chat model" so the retry hits
		// a distinct model and the guard doesn't short-circuit. Both
		// ids must exist in pi-ai's registry.
		completeSimpleMock = async (model) => {
			if (model.id === "moonshotai/kimi-k2.6") {
				throw new Error("simulated model-unavailable");
			}
			return makeAssistantReply("Retry Succeeded");
		};

		const title = await generateSessionTitle({
			activeProviderId: "openrouter",
			activeModelId: "anthropic/claude-haiku-4.5",
			prompt: "anything",
		});

		expect(title).toBe("Retry Succeeded");
		expect(completeSimpleCalls.length).toBe(2);
		expect(completeSimpleCalls[0]?.modelId).toBe("moonshotai/kimi-k2.6");
		expect(completeSimpleCalls[1]?.modelId).toBe("anthropic/claude-haiku-4.5");
		// Api key flows on both hops — both the primary and the retry
		// must be authenticated. Re-resolving through the provider on
		// the retry path (so a different-provider fallback gets the
		// right key) is load-bearing; the test pins that both calls
		// carry a defined key string.
		expect(completeSimpleCalls[0]?.apiKey).toBe("sk-or-v1-test");
		expect(completeSimpleCalls[1]?.apiKey).toBe("sk-or-v1-test");
	});

	test("primary model equals chat model → no retry when first throws", async () => {
		// With `activeModelId` equal to the provider default, both
		// hops of `resolveTitleModel` produce the same model. The
		// retry guard skips so we don't burn a second identical
		// request.
		completeSimpleMock = async () => {
			throw new Error("simulated model-unavailable");
		};

		const title = await generateSessionTitle({
			activeProviderId: "openrouter",
			activeModelId: "moonshotai/kimi-k2.6",
			prompt: "anything",
		});

		expect(title).toBeNull();
		expect(completeSimpleCalls.length).toBe(1);
	});

	test("both attempts throw → returns null", async () => {
		completeSimpleMock = async () => {
			throw new Error("still broken");
		};

		const title = await generateSessionTitle({
			activeProviderId: "openrouter",
			activeModelId: "anthropic/claude-haiku-4.5",
			prompt: "anything",
		});

		expect(title).toBeNull();
		expect(completeSimpleCalls.length).toBe(2);
	});

	test("empty cleaned output on primary → returns null without retry", async () => {
		// `cleanSessionTitle("\n\n")` → null. This is a successful
		// call with empty content, which is a valid "no title"
		// signal (safety filter, refused short input) — retrying on
		// the chat model would burn tokens for the same answer.
		completeSimpleMock = async () => makeAssistantReply("\n\n");

		const title = await generateSessionTitle({
			activeProviderId: "openrouter",
			activeModelId: "anthropic/claude-haiku-4.5",
			prompt: "anything",
		});

		expect(title).toBeNull();
		expect(completeSimpleCalls.length).toBe(1);
	});
});

describe("resolveTitleModel precedence via generateSessionTitle", () => {
	const CONFIG_FILE = join(CONFIG_HOME, "inkstone", "config.json");

	function readCurrentConfig(): Record<string, unknown> {
		try {
			return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
		} catch {
			return {};
		}
	}

	async function resetConfig(): Promise<void> {
		const current = readCurrentConfig();
		const next: Record<string, unknown> = {};
		if (typeof current.vaultDir === "string") next.vaultDir = current.vaultDir;
		writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
		// Drop the module cache so a subsequent `loadConfig()` picks up
		// the reset file, not the previous test's seeded override.
		const { resetConfigCache } = await import(
			"../src/backend/persistence/config"
		);
		resetConfigCache();
	}

	beforeEach(async () => {
		completeSimpleCalls.length = 0;
		completeSimpleMock = async () => {
			throw new Error("completeSimpleMock not configured");
		};
		await resetConfig();
	});

	afterEach(async () => {
		// Reset after each test too so an override set by this suite
		// doesn't leak into later test files (mini-model.test.tsx
		// depends on config.sessionTitleModel being undefined at
		// dialog open).
		await resetConfig();
	});

	test("config.sessionTitleModel beats provider titleModelId", async () => {
		// Seed an explicit override. Override provider/model differs
		// from the active chat provider (`openrouter`) and from
		// OpenRouter's built-in `titleModelId` (`moonshotai/kimi-k2.6`)
		// so the call site unambiguously pins precedence.
		//
		// The cache was already dropped in `beforeEach`'s `resetConfig`;
		// after this writeFile, we need to drop it again because the
		// `resetConfig` path re-primed `cached` to the baseline (empty
		// + vaultDir) via its own `loadConfig` chain. Without this
		// second reset, `loadConfig()` inside `resolveTitleModel`
		// would return the pre-write baseline and the precedence
		// assertion would fail for the wrong reason (missing override,
		// not wrong precedence).
		writeFileSync(
			CONFIG_FILE,
			JSON.stringify(
				{
					vaultDir: (readCurrentConfig().vaultDir as string | undefined) ?? "",
					sessionTitleModel: {
						providerId: "openrouter",
						modelId: "deepseek/deepseek-chat-v3.1",
					},
				},
				null,
				2,
			),
		);
		const { resetConfigCache } = await import(
			"../src/backend/persistence/config"
		);
		resetConfigCache();

		completeSimpleMock = async () => makeAssistantReply("Configured Title");

		const title = await generateSessionTitle({
			activeProviderId: "openrouter",
			activeModelId: "anthropic/claude-haiku-4.5",
			prompt: "anything",
		});

		expect(title).toBe("Configured Title");
		expect(completeSimpleCalls.length).toBe(1);
		expect(completeSimpleCalls[0]?.modelId).toBe("deepseek/deepseek-chat-v3.1");
		expect(completeSimpleCalls[0]?.provider).toBe("openrouter");
	});
});
