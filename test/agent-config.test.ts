/**
 * Pure-function tests for the unified-config resolvers + setters in
 * `src/backend/persistence/agent-config.ts`.
 *
 * These functions are the entire mechanism by which the unified config
 * delivers per-agent overrides:
 *   - resolveAgentModel      → agent override > top-level > null
 *   - resolveAgentThinkingLevel → agent override > top-level > "off"
 *   - setAgentModel          → write or remove an agent's model field
 *   - setAgentThinkingLevel  → write or remove a specific (provider,model) key
 *
 * No I/O — these tests are pure. They cover the resolver fall-through
 * matrix, the per-agent isolation invariant (writing one agent does
 * not touch another), and the null-input semantics for both setters.
 *
 * `vaultDir` is required by the schema; the fixtures include a stub
 * value so the assertions isolate per-agent behavior under test.
 */

import { describe, expect, test } from "bun:test";
import {
	resolveAgentModel,
	resolveAgentThinkingLevel,
	setAgentModel,
	setAgentThinkingLevel,
} from "../src/backend/persistence/agent-config";
import { Config } from "../src/backend/persistence/schema";

const VAULT = "/tmp/vault";
const A = { providerId: "kiro", modelId: "claude-3-5-sonnet" };
const B = { providerId: "openrouter", modelId: "anthropic/claude-haiku-4.5" };

describe("resolveAgentModel", () => {
	test("empty config → null", () => {
		const cfg: Config = { vaultDir: VAULT };
		expect(resolveAgentModel(cfg, "reader")).toBeNull();
	});

	test("top-level only → top-level", () => {
		const cfg: Config = { vaultDir: VAULT, model: A };
		expect(resolveAgentModel(cfg, "reader")).toEqual(A);
	});

	test("agent override only → agent", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			agents: { reader: { model: B } },
		};
		expect(resolveAgentModel(cfg, "reader")).toEqual(B);
	});

	test("both set → agent wins", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			model: A,
			agents: { reader: { model: B } },
		};
		expect(resolveAgentModel(cfg, "reader")).toEqual(B);
	});

	test("override on a different agent does not leak", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			model: A,
			agents: { "knowledge-base": { model: B } },
		};
		expect(resolveAgentModel(cfg, "reader")).toEqual(A);
		expect(resolveAgentModel(cfg, "knowledge-base")).toEqual(B);
	});
});

describe("resolveAgentThinkingLevel", () => {
	const KEY_A = `${A.providerId}/${A.modelId}`;
	const KEY_B = `${B.providerId}/${B.modelId}`;

	test("empty config → 'off'", () => {
		const cfg: Config = { vaultDir: VAULT };
		expect(
			resolveAgentThinkingLevel(cfg, "reader", A.providerId, A.modelId),
		).toBe("off");
	});

	test("top-level only → top-level value for matching key", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			thinkingLevels: { [KEY_A]: "high" },
		};
		expect(
			resolveAgentThinkingLevel(cfg, "reader", A.providerId, A.modelId),
		).toBe("high");
		// Different model key falls through to "off".
		expect(
			resolveAgentThinkingLevel(cfg, "reader", B.providerId, B.modelId),
		).toBe("off");
	});

	test("agent override beats top-level for the same key", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			thinkingLevels: { [KEY_A]: "low" },
			agents: { reader: { thinkingLevels: { [KEY_A]: "high" } } },
		};
		expect(
			resolveAgentThinkingLevel(cfg, "reader", A.providerId, A.modelId),
		).toBe("high");
	});

	test("agent map covers one key; another key falls through to top-level", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			thinkingLevels: { [KEY_A]: "low", [KEY_B]: "medium" },
			agents: { reader: { thinkingLevels: { [KEY_A]: "high" } } },
		};
		expect(
			resolveAgentThinkingLevel(cfg, "reader", A.providerId, A.modelId),
		).toBe("high");
		expect(
			resolveAgentThinkingLevel(cfg, "reader", B.providerId, B.modelId),
		).toBe("medium");
	});

	test("override on a different agent does not leak", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			agents: { "knowledge-base": { thinkingLevels: { [KEY_A]: "xhigh" } } },
		};
		expect(
			resolveAgentThinkingLevel(cfg, "reader", A.providerId, A.modelId),
		).toBe("off");
		expect(
			resolveAgentThinkingLevel(cfg, "knowledge-base", A.providerId, A.modelId),
		).toBe("xhigh");
	});
});

describe("setAgentModel", () => {
	test("creates agents map + agent block when neither exists", () => {
		const cfg: Config = { vaultDir: VAULT };
		const next = setAgentModel(cfg, "reader", A);
		expect(next.agents?.reader?.model).toEqual(A);
		// Top-level model is left alone.
		expect(next.model).toBeUndefined();
		// Original config is not mutated.
		expect(cfg.agents).toBeUndefined();
	});

	test("preserves the agent's existing thinkingLevels when writing model", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			agents: {
				reader: { thinkingLevels: { "kiro/claude-3-5-sonnet": "high" } },
			},
		};
		const next = setAgentModel(cfg, "reader", B);
		expect(next.agents?.reader?.model).toEqual(B);
		expect(next.agents?.reader?.thinkingLevels).toEqual({
			"kiro/claude-3-5-sonnet": "high",
		});
	});

	test("preserves OTHER agents when writing one agent's model", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			agents: { "knowledge-base": { model: A } },
		};
		const next = setAgentModel(cfg, "reader", B);
		expect(next.agents?.reader?.model).toEqual(B);
		expect(next.agents?.["knowledge-base"]?.model).toEqual(A);
	});

	test("null clears the agent's model field; thinkingLevels untouched", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			agents: {
				reader: { model: A, thinkingLevels: { "kiro/foo": "high" } },
			},
		};
		const next = setAgentModel(cfg, "reader", null);
		expect(next.agents?.reader?.model).toBeUndefined();
		expect(next.agents?.reader?.thinkingLevels).toEqual({ "kiro/foo": "high" });
	});

	test("null on an agent that has no override is a no-op-equivalent", () => {
		const cfg: Config = { vaultDir: VAULT, model: A };
		const next = setAgentModel(cfg, "reader", null);
		// Top-level still wins via resolveAgentModel.
		expect(resolveAgentModel(next, "reader")).toEqual(A);
	});
});

describe("schema validation", () => {
	test("vaultDir is required", () => {
		expect(Config.safeParse({}).success).toBe(false);
		expect(Config.safeParse({ themeId: "dark" }).success).toBe(false);
	});

	test("minimal valid config has only vaultDir", () => {
		const result = Config.safeParse({ vaultDir: VAULT });
		expect(result.success).toBe(true);
	});

	test("legacy flat providerId/modelId at top level is rejected", () => {
		// Pre-refactor schema had `providerId` and `modelId` as flat
		// optional fields. The new shape nests them under `model`. Strict
		// mode surfaces the old keys as unknown so a user with an old
		// config sees a named error rather than silent data loss.
		const result = Config.safeParse({
			vaultDir: VAULT,
			providerId: "kiro",
			modelId: "claude-3-5-sonnet",
		});
		expect(result.success).toBe(false);
	});

	test("legacy currentAgent at top level is rejected", () => {
		// Plan D8: currentAgent is no longer persisted. Strict mode
		// surfaces it as unknown in case a stale config carries it.
		const result = Config.safeParse({
			vaultDir: VAULT,
			currentAgent: "reader",
		});
		expect(result.success).toBe(false);
	});

	test("structured top-level model is accepted", () => {
		const result = Config.safeParse({ vaultDir: VAULT, model: A });
		expect(result.success).toBe(true);
	});

	test("agents map with sparse blocks is accepted", () => {
		const result = Config.safeParse({
			vaultDir: VAULT,
			agents: {
				reader: { model: A },
				"knowledge-base": {
					thinkingLevels: { "kiro/claude-3-5-sonnet": "high" },
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("unknown keys inside an agent block are rejected", () => {
		const result = Config.safeParse({
			vaultDir: VAULT,
			agents: { reader: { unknownField: "x" } },
		});
		expect(result.success).toBe(false);
	});

	test("malformed model ref inside agent block is rejected", () => {
		const result = Config.safeParse({
			vaultDir: VAULT,
			agents: { reader: { model: { providerId: "", modelId: "x" } } },
		});
		expect(result.success).toBe(false);
	});
});

describe("setAgentThinkingLevel", () => {
	const KEY_A = `${A.providerId}/${A.modelId}`;
	const KEY_B = `${B.providerId}/${B.modelId}`;

	test("creates agents map + block + map when none exists", () => {
		const cfg: Config = { vaultDir: VAULT };
		const next = setAgentThinkingLevel(
			cfg,
			"reader",
			A.providerId,
			A.modelId,
			"high",
		);
		expect(next.agents?.reader?.thinkingLevels).toEqual({ [KEY_A]: "high" });
		// Original is not mutated.
		expect(cfg.agents).toBeUndefined();
	});

	test("writes new key without clobbering existing keys in the same map", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			agents: { reader: { thinkingLevels: { [KEY_A]: "low" } } },
		};
		const next = setAgentThinkingLevel(
			cfg,
			"reader",
			B.providerId,
			B.modelId,
			"high",
		);
		expect(next.agents?.reader?.thinkingLevels).toEqual({
			[KEY_A]: "low",
			[KEY_B]: "high",
		});
	});

	test("preserves the agent's model when writing thinking level", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			agents: { reader: { model: A } },
		};
		const next = setAgentThinkingLevel(
			cfg,
			"reader",
			A.providerId,
			A.modelId,
			"medium",
		);
		expect(next.agents?.reader?.model).toEqual(A);
		expect(next.agents?.reader?.thinkingLevels).toEqual({ [KEY_A]: "medium" });
	});

	test("preserves OTHER agents when writing one agent's level", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			agents: {
				"knowledge-base": { thinkingLevels: { [KEY_A]: "high" } },
			},
		};
		const next = setAgentThinkingLevel(
			cfg,
			"reader",
			A.providerId,
			A.modelId,
			"low",
		);
		expect(next.agents?.reader?.thinkingLevels).toEqual({ [KEY_A]: "low" });
		expect(next.agents?.["knowledge-base"]?.thinkingLevels).toEqual({
			[KEY_A]: "high",
		});
	});

	test("null removes only the matching key; other keys preserved", () => {
		const cfg: Config = {
			vaultDir: VAULT,
			agents: {
				reader: { thinkingLevels: { [KEY_A]: "high", [KEY_B]: "medium" } },
			},
		};
		const next = setAgentThinkingLevel(
			cfg,
			"reader",
			A.providerId,
			A.modelId,
			null,
		);
		expect(next.agents?.reader?.thinkingLevels).toEqual({ [KEY_B]: "medium" });
	});

	test("null on a non-existent key is a no-op-equivalent", () => {
		const cfg: Config = { vaultDir: VAULT };
		const next = setAgentThinkingLevel(
			cfg,
			"reader",
			A.providerId,
			A.modelId,
			null,
		);
		expect(
			resolveAgentThinkingLevel(next, "reader", A.providerId, A.modelId),
		).toBe("off");
	});
});
