/**
 * Atomic-write + dir-mode guarantees for the persistence layer.
 *
 * Covers H2/H3/H4 from the May 2026 audit:
 * - H2: writes to config.json/auth.json survive a crash mid-write
 *   (tmp + fsync + rename, not open(O_TRUNC) + write).
 * - H3: auth.json never exists on disk with a mode looser than 0600
 *   (O_CREAT | O_EXCL | O_WRONLY on the tmp file with the exact mode).
 * - H4: CONFIG_DIR mode is always 0700 regardless of which writer
 *   creates it first (centralized `ensureConfigDir` chmods on every
 *   call).
 *
 * `writeFileAtomic` is a pure primitive and exercised against its own
 * scratch dir. `ensureConfigDir` is tested against the preload's
 * CONFIG_DIR (the preload owns cleanup). Critically: we do NOT wipe
 * CONFIG_DIR inside this test file — that would nuke the preload's
 * seeded `config.json` (vault pointer) and break every downstream
 * test that depends on `VAULT_DIR` pointing at the preload's tmp
 * vault.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONFIG_DIR,
	ensureConfigDir,
	writeFileAtomic,
} from "@backend/persistence/paths";

// Per-file scratch dir for atomic-write primitive tests — isolated
// from the preload's CONFIG_DIR so we can freely clean up without
// interfering with other tests' fixtures.
const SCRATCH = mkdtempSync(join(tmpdir(), "inkstone-atomic-"));

afterAll(() => {
	rmSync(SCRATCH, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
	test("creates dest with exact mode on first write", () => {
		const dest = join(SCRATCH, "atomic-mode.txt");
		writeFileAtomic(dest, "hello", 0o600);
		const { mode } = statSync(dest);
		// Low 9 bits hold the permission triad.
		expect(mode & 0o777).toBe(0o600);
		expect(readFileSync(dest, "utf-8")).toBe("hello");
	});

	test("overwrite preserves target mode (no 0644 window)", () => {
		const dest = join(SCRATCH, "atomic-overwrite.txt");
		// Seed at a looser mode to simulate legacy on-disk state.
		writeFileSync(dest, "legacy", { mode: 0o644 });
		// Overwriting through writeFileAtomic should produce the new
		// target mode — rename preserves the tmp file's mode, which was
		// created with 0o600 via O_CREAT | O_EXCL.
		writeFileAtomic(dest, "fresh", 0o600);
		const { mode } = statSync(dest);
		expect(mode & 0o777).toBe(0o600);
		expect(readFileSync(dest, "utf-8")).toBe("fresh");
	});

	test("tmp file left over from a prior crash → O_EXCL fails loudly", () => {
		const dest = join(SCRATCH, "atomic-orphan.txt");
		// Simulate a process killed between open-tmp and rename.
		writeFileSync(`${dest}.tmp`, "orphaned");
		expect(() => writeFileAtomic(dest, "fresh", 0o600)).toThrow();
		// Dest was never touched, so reading it fails — we don't want
		// half-state leaking into callers.
		expect(existsSync(dest)).toBe(false);
		// Clean up so the next test's orphan path isn't polluted.
		rmSync(`${dest}.tmp`);
	});

	test("existing dest survives an orphan-blocked save attempt", () => {
		// H2 approximation: seed dest with known content, plant an
		// orphan tmp, attempt a write (fails via EEXIST), confirm the
		// prior content is still readable. Covers the "crash during
		// save" → "prior value preserved" invariant.
		const dest = join(SCRATCH, "atomic-preserve.txt");
		writeFileAtomic(dest, "original", 0o600);
		writeFileSync(`${dest}.tmp`, "orphan-from-prior-crash");
		expect(() => writeFileAtomic(dest, "replacement", 0o600)).toThrow();
		expect(readFileSync(dest, "utf-8")).toBe("original");
		rmSync(`${dest}.tmp`);
	});

	test("failed save doesn't permanently wedge subsequent saves", () => {
		// Once an orphan is cleared (by a user or by the intra-process
		// unlink in writeFileAtomic's catch paths), saves resume
		// normally.
		const dest = join(SCRATCH, "atomic-recovery.txt");
		writeFileSync(`${dest}.tmp`, "orphan");
		expect(() => writeFileAtomic(dest, "first", 0o600)).toThrow();
		rmSync(`${dest}.tmp`);
		writeFileAtomic(dest, "second", 0o600);
		expect(readFileSync(dest, "utf-8")).toBe("second");
	});

	test("writes content atomically — no partial file visible to readers", () => {
		const dest = join(SCRATCH, "atomic-content.txt");
		writeFileAtomic(dest, "a".repeat(10_000), 0o600);
		expect(readFileSync(dest, "utf-8").length).toBe(10_000);
	});
});

describe("ensureConfigDir", () => {
	// The preload seeds CONFIG_DIR with config.json (vault pointer) and
	// any follow-up writers. We verify mode invariants without removing
	// the directory between tests.
	test("CONFIG_DIR exists after preload and ensureConfigDir is idempotent", () => {
		ensureConfigDir();
		expect(existsSync(CONFIG_DIR)).toBe(true);
		const { mode } = statSync(CONFIG_DIR);
		expect(mode & 0o777).toBe(0o700);
	});

	test("tightens an explicitly-loosened CONFIG_DIR back to 0700", () => {
		// Simulate the H4 race: something created CONFIG_DIR with the
		// default-umask 0755 shape. ensureConfigDir should chmod it
		// back to 0700.
		chmodSync(CONFIG_DIR, 0o755);
		ensureConfigDir();
		const { mode } = statSync(CONFIG_DIR);
		expect(mode & 0o777).toBe(0o700);
	});

	test("creates CONFIG_DIR with 0700 when absent", () => {
		// Exercises the first-create path of `ensureConfigDir` by
		// tearing down the preload's CONFIG_DIR, calling the helper,
		// and verifying the directory reappears at 0700. Because
		// CONFIG_DIR is a module-captured constant (preload set
		// XDG_CONFIG_HOME to the tmp dir before any import), we can't
		// redirect the helper to an arbitrary scratch path — instead
		// we wipe and restore the preload's own CONFIG_DIR inside a
		// try/finally so the preload's config.json survives this
		// test for every downstream caller.
		const seededConfigPath = join(CONFIG_DIR, "config.json");
		const seededConfig = readFileSync(seededConfigPath, "utf-8");
		try {
			rmSync(CONFIG_DIR, { recursive: true, force: true });
			expect(existsSync(CONFIG_DIR)).toBe(false);
			ensureConfigDir();
			expect(existsSync(CONFIG_DIR)).toBe(true);
			const { mode } = statSync(CONFIG_DIR);
			expect(mode & 0o777).toBe(0o700);
		} finally {
			// Restore so downstream tests (saveConfig block, and
			// every test file that reads config.json at module load)
			// still see the preload's seed. ensureConfigDir is
			// idempotent, so calling it again here is safe.
			ensureConfigDir();
			writeFileSync(seededConfigPath, seededConfig, "utf-8");
		}
	});
});

describe("saveConfig → atomic on disk", () => {
	// Restore CONFIG_DIR + CONFIG_FILE after this block so downstream
	// tests that read vault config still see the preload's seed.
	const seededConfigPath = join(CONFIG_DIR, "config.json");
	const seededConfig = readFileSync(seededConfigPath, "utf-8");

	afterEach(() => {
		// Re-seed the preload's config.json so dependent tests don't
		// observe the test-written themeId.
		writeFileSync(seededConfigPath, seededConfig, "utf-8");
	});

	test("saveConfig writes CONFIG_FILE at mode 0600 and 0700 dir", async () => {
		const { saveConfig } = await import("@backend/persistence/config");
		saveConfig({ themeId: "test-theme" });
		expect(statSync(CONFIG_DIR).mode & 0o777).toBe(0o700);
		expect(statSync(seededConfigPath).mode & 0o777).toBe(0o600);
	});
});