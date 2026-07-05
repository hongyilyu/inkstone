import { ProviderHelperLine } from "@inkstone/protocol";
import { Schema as S } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	type HelperDeps,
	type HelperIo,
	runHelperMain,
	SUPPORTED_PROVIDERS,
	toCoreCredentials,
} from "../src/helper-main.js";

const capture = (
	firstLine: string | null = JSON.stringify({ refresh: "tok" }),
): { lines: unknown[]; io: HelperIo } => {
	const lines: unknown[] = [];
	const io: HelperIo = {
		emit: (l) => lines.push(l),
		readFirstLine: async () => firstLine,
	};
	return { lines, io };
};

/** Every emitted line must satisfy the contract union — the tie between these
 * unit tests and the fixture-gated ProviderHelperLine schema. */
const assertContractLines = (lines: unknown[]): void => {
	for (const l of lines) S.decodeUnknownSync(ProviderHelperLine)(l);
};

const creds = {
	access: "access_a",
	refresh: "refresh_a",
	expires: 1_750_000_000_000,
	accountId: "acct_a",
};

describe("toCoreCredentials", () => {
	it("maps camelCase accountId to snake_case account_id", () => {
		expect(toCoreCredentials(creds)).toEqual({
			kind: "credentials",
			access: "access_a",
			refresh: "refresh_a",
			expires: 1_750_000_000_000,
			account_id: "acct_a",
		});
	});

	it("maps a non-string accountId to the empty string", () => {
		expect(toCoreCredentials({ ...creds, accountId: 42 })).toMatchObject({
			account_id: "",
		});
	});
});

describe("refresh mode", () => {
	it("feeds the stdin token to the refresh dep and emits one credentials line", async () => {
		const { lines, io } = capture();
		const deps: HelperDeps = {
			login: vi.fn(),
			refresh: vi.fn().mockResolvedValue(creds),
		};
		const code = await runHelperMain(["refresh", "openai-codex"], deps, io);
		expect(code).toBe(0);
		expect(deps.refresh).toHaveBeenCalledWith("tok");
		expect(lines).toEqual([
			{
				kind: "credentials",
				access: "access_a",
				refresh: "refresh_a",
				expires: 1_750_000_000_000,
				account_id: "acct_a",
			},
		]);
		assertContractLines(lines);
	});

	it("failure emits the fixed redacted message and never the token", async () => {
		const { lines, io } = capture();
		const deps: HelperDeps = {
			login: vi.fn(),
			refresh: vi
				.fn()
				.mockRejectedValue(new Error("upstream said: tok is invalid")),
		};
		const code = await runHelperMain(["refresh", "openai-codex"], deps, io);
		expect(code).toBe(1);
		expect(lines).toEqual([{ kind: "error", message: "refresh failed" }]);
		expect(JSON.stringify(lines)).not.toContain("tok is invalid");
		assertContractLines(lines);
	});

	it("empty stdin emits the no-input error without calling the refresh dep", async () => {
		const { lines, io } = capture(null);
		const deps: HelperDeps = { login: vi.fn(), refresh: vi.fn() };
		const code = await runHelperMain(["refresh", "openai-codex"], deps, io);
		expect(code).toBe(1);
		expect(deps.refresh).not.toHaveBeenCalled();
		expect(lines).toEqual([
			{ kind: "error", message: "refresh: no input on stdin" },
		]);
		assertContractLines(lines);
	});
});

describe("login mode", () => {
	it("emits authorize_url then credentials, in order", async () => {
		const { lines, io } = capture();
		const deps: HelperDeps = {
			login: vi.fn(async (hooks) => {
				hooks.onAuth({ url: "https://auth.example/authorize" });
				return creds;
			}),
			refresh: vi.fn(),
		};
		const code = await runHelperMain(["login", "openai-codex"], deps, io);
		expect(code).toBe(0);
		expect(lines).toEqual([
			{ kind: "authorize_url", url: "https://auth.example/authorize" },
			{
				kind: "credentials",
				access: "access_a",
				refresh: "refresh_a",
				expires: 1_750_000_000_000,
				account_id: "acct_a",
			},
		]);
		assertContractLines(lines);
	});

	it("a throwing login dep emits the fixed redacted message, not the error text", async () => {
		const { lines, io } = capture();
		const deps: HelperDeps = {
			login: vi.fn().mockRejectedValue(new Error("secret refresh_a leaked")),
			refresh: vi.fn(),
		};
		const code = await runHelperMain(["login", "openai-codex"], deps, io);
		expect(code).toBe(1);
		expect(lines).toEqual([
			{ kind: "error", message: "provider helper failed" },
		]);
		expect(JSON.stringify(lines)).not.toContain("refresh_a");
		assertContractLines(lines);
	});
});

describe("argv dispatch", () => {
	it("unknown mode emits one error line and never touches the deps", async () => {
		const { lines, io } = capture();
		const deps: HelperDeps = { login: vi.fn(), refresh: vi.fn() };
		const code = await runHelperMain(["frobnicate", "openai-codex"], deps, io);
		expect(code).toBe(1);
		expect(deps.login).not.toHaveBeenCalled();
		expect(deps.refresh).not.toHaveBeenCalled();
		expect(lines).toEqual([
			{ kind: "error", message: "unknown provider-helper mode: frobnicate" },
		]);
		assertContractLines(lines);
	});

	it("missing provider is rejected before any OAuth dep runs", async () => {
		const { lines, io } = capture();
		const deps: HelperDeps = { login: vi.fn(), refresh: vi.fn() };
		const code = await runHelperMain(["login"], deps, io);
		expect(code).toBe(1);
		expect(deps.login).not.toHaveBeenCalled();
		expect(lines).toEqual([
			{ kind: "error", message: "unsupported provider: <none>" },
		]);
		assertContractLines(lines);
	});

	it("unknown provider is rejected before any OAuth dep runs", async () => {
		const { lines, io } = capture();
		const deps: HelperDeps = { login: vi.fn(), refresh: vi.fn() };
		const code = await runHelperMain(["login", "acme"], deps, io);
		expect(code).toBe(1);
		expect(deps.login).not.toHaveBeenCalled();
		expect(deps.refresh).not.toHaveBeenCalled();
		expect(lines).toEqual([
			{ kind: "error", message: "unsupported provider: acme" },
		]);
		assertContractLines(lines);
	});

	it("the supported set is exactly openai-codex (Core's HELPER_SUPPORTED_PROVIDERS mirror)", () => {
		expect(SUPPORTED_PROVIDERS).toEqual(["openai-codex"]);
	});
});
