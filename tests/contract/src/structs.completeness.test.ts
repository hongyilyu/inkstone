// The non-payload completeness lock (grilling Q10). The per-fixture parity test
// (`structs.test.ts`) catches a CHANGED field; this catches a MISSING (or stray)
// MESSAGE or union VARIANT — the failure mode per-fixture assertions are blind
// to. It pins three views of the in-scope set equal:
//   1. the distinct `message` values the registry actually asserts,
//   2. the committed fixture filenames on disk (both `emitted/` and `authored/`),
//   3. `CANONICAL_MESSAGES` — the hand-maintained list mirroring the 33 in-scope
//      Rust wire structs.
// Plus an explicit per-union variant count: a tagged union must contribute
// exactly one fixture per wire variant, so a silently-dropped variant reds.
//
// Unlike `completeness.test.ts` (the 14-payload lock), this set grows per slice;
// the assertions are derived, so adding a fixture without declaring its message
// (or vice versa) fails here.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CANONICAL_MESSAGES,
	fixtures,
	UNION_VARIANTS,
} from "./structs.registry.js";

const asSet = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

const fixtureFilesOnDisk = (dir: string): string[] => {
	const root = fileURLToPath(
		new URL(`../fixtures/structs/${dir}/`, import.meta.url),
	);
	try {
		return readdirSync(root).filter((n) => n.endsWith(".json"));
	} catch (error: unknown) {
		// A not-yet-created dir is empty; any other error (EACCES, EIO) is real and
		// must red the lock rather than vacuously pass the existence/stray loops.
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
};

describe("non-payload completeness lock", () => {
	it("registry messages == canonical message list (none undeclared, none stray)", () => {
		const registryMessages = asSet(fixtures.map((f) => f.message));
		expect(registryMessages).toStrictEqual(asSet(CANONICAL_MESSAGES));
	});

	it("every registry fixture file exists on disk in its declared dir", () => {
		for (const dir of ["emitted", "authored"] as const) {
			const declared = asSet(
				fixtures.filter((f) => f.dir === dir).map((f) => f.file),
			);
			const onDisk = asSet(fixtureFilesOnDisk(dir));
			// Every declared fixture must exist; a declared-but-missing file reds.
			for (const file of declared) {
				expect(onDisk).toContain(file);
			}
		}
	});

	it("no stray fixture file lacks a registry entry", () => {
		// Dir-qualified (`<dir>/<file>`), so a misregistered cross-dir copy — a stray
		// authored/foo.json when only emitted/foo.json is declared — is caught too.
		const declaredFiles = asSet(fixtures.map((f) => `${f.dir}/${f.file}`));
		for (const dir of ["emitted", "authored"] as const) {
			for (const file of fixtureFilesOnDisk(dir)) {
				expect(declaredFiles).toContain(`${dir}/${file}`);
			}
		}
	});

	it("each tagged union contributes exactly its variant count of fixtures", () => {
		for (const [message, count] of Object.entries(UNION_VARIANTS)) {
			const got = fixtures.filter((f) => f.message === message).length;
			expect(got, `${message} variant fixture count`).toBe(count);
		}
	});
});
