import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import antiSlopPlugin from "../index.ts";

interface RuleCase {
	readonly rule: string;
	readonly invalid: string;
	readonly valid: string;
}

const cases: readonly RuleCase[] = [
	{
		rule: "no-chained-type-assertions",
		invalid:
			"declare const value: string; const output = value as unknown as number; void output;",
		valid:
			"declare const value: unknown; const output = value as string; void output;",
	},
	{
		rule: "no-conditional-empty-object-spread",
		invalid:
			"declare const enabled: boolean; const value = { ...(enabled ? { id: 1 } : {}) }; void value;",
		valid:
			"declare const enabled: boolean; const value: { id?: number } = {}; if (enabled) value.id = 1;",
	},
	{
		rule: "no-known-value-widening",
		invalid: 'const value: unknown = "known"; void value;',
		valid: 'const value = "known"; void value;',
	},
	{
		rule: "no-module-mocking",
		invalid: 'import { vi } from "vitest"; vi.mock("./dependency.js");',
		valid:
			"const local = { mock: (_path: string) => undefined }; local.mock('./dependency.js');",
	},
	{
		rule: "no-object-parameters",
		invalid: "function read(value: object): void { void value; }",
		valid: "function read(value: { id: string }): void { void value.id; }",
	},
	{
		rule: "no-reflect-apply",
		invalid: "const fn = () => 1; Reflect.apply(fn, null, []);",
		valid: "const fn = () => 1; fn();",
	},
	{
		rule: "no-reflect-get",
		invalid: "const value = { id: 1 }; Reflect.get(value, 'id');",
		valid: "const value = { id: 1 }; void value.id;",
	},
	{
		rule: "no-shape-in-symbol-names",
		invalid: "const payloadShape = {}; void payloadShape;",
		valid: "const payloadContract = {}; void payloadContract;",
	},
	{
		rule: "no-unknown-parameters",
		invalid: "function parse(input: unknown): void { void input; }",
		valid:
			"function isString(input: unknown): input is string { return typeof input === 'string'; } void isString;",
	},
	{
		rule: "no-unknown-returns",
		invalid: "function read(): unknown { return 1; } void read();",
		valid: "function read(): number { return 1; } void read();",
	},
	{
		rule: "no-unknown-type-aliases",
		invalid: "type Input = unknown; declare const input: Input; void input;",
		valid: "type Input = string; declare const input: Input; void input;",
	},
	{
		rule: "no-unsafe-dictionary-type",
		invalid:
			"type Values = Record<string, unknown>; declare const values: Values; void values;",
		valid:
			"type Values = Record<string, string>; declare const values: Values; void values;",
	},
	{
		rule: "no-widen-then-assert",
		invalid:
			"const precise = { id: 'x' }; const broad: unknown = precise; const restored = broad as { id: string }; void restored;",
		valid:
			"const precise = { id: 'x' }; const restored = precise; void restored.id;",
	},
];

const packageDir = dirname(
	fileURLToPath(new URL("../package.json", import.meta.url)),
);
const pluginPath = join(packageDir, "index.ts");
const oxlintPackage = fileURLToPath(import.meta.resolve("oxlint/package.json"));
const oxlintBin = join(dirname(oxlintPackage), "bin", "oxlint");
const tempDir = mkdtempSync(join(tmpdir(), "inkstone-anti-slop-"));

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function lint(rule: string, source: string) {
	const caseDir = mkdtempSync(join(tempDir, "case-"));
	const sourcePath = join(caseDir, "input.ts");
	const configPath = join(caseDir, "oxlint.json");
	writeFileSync(sourcePath, source);
	writeFileSync(
		configPath,
		JSON.stringify({
			jsPlugins: [{ name: "anti-slop", specifier: pluginPath }],
			rules: { [`anti-slop/${rule}`]: "error" },
		}),
	);
	return spawnSync(
		oxlintBin,
		["--config", configPath, "--format", "json", "--no-ignore", sourcePath],
		{ encoding: "utf8" },
	);
}

describe("anti-slop rules", () => {
	it("covers every registered rule", () => {
		expect(Object.keys(antiSlopPlugin.rules).sort()).toEqual(
			cases.map(({ rule }) => rule).sort(),
		);
	});

	for (const ruleCase of cases) {
		it(`${ruleCase.rule} rejects its target and accepts its control`, () => {
			const diagnosticCode = `anti-slop(${ruleCase.rule})`;
			const invalid = lint(ruleCase.rule, ruleCase.invalid);
			expect(invalid.status, invalid.stderr || invalid.stdout).toBe(1);
			expect(invalid.stdout).toContain(diagnosticCode);

			const valid = lint(ruleCase.rule, ruleCase.valid);
			expect(valid.status, valid.stderr || valid.stdout).toBe(0);
			expect(valid.stdout).not.toContain(diagnosticCode);
		});
	}
});
