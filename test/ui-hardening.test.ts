/**
 * Tests for `stripAnsi` + `openVaultFilePart` symlink reject.
 *
 * Covers M3 (symlink escape via file-chip click) and M4 (ANSI
 * escape-code injection via tool-arg rendering) from the May 2026
 * audit.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "@tui/util/ansi";
import { summarizeToolArgs } from "@tui/util/tool-summary";
import { VAULT } from "./preload";

describe("stripAnsi", () => {
	test("strips CSI sequences (cursor moves, SGR, clears)", () => {
		expect(stripAnsi("hello\x1b[2Jworld")).toBe("helloworld");
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
		expect(stripAnsi("\x1b[1;32mbold-green\x1b[m")).toBe("bold-green");
	});

	test("strips C0 control bytes except TAB/LF/CR", () => {
		// \x00 (NUL), \x07 (BEL), \x08 (BS), \x0B (VT), \x7F (DEL) go;
		// \x09 (TAB), \x0A (LF), \x0D (CR) stay.
		expect(stripAnsi("a\x00b\x07c\x08d\x7Fe")).toBe("abcde");
		expect(stripAnsi("line1\nline2\tindented\rreturn")).toBe(
			"line1\nline2\tindented\rreturn",
		);
	});

	test("strips 8-bit CSI (single-byte 0x9B in place of ESC [)", () => {
		// Some terminals in 8-bit mode accept 0x9B as a CSI intro. It
		// lives in the C1 range which our CONTROL_BYTES regex now
		// scrubs. The `2J` residue survives as visible text, not a
		// terminal command.
		expect(stripAnsi("hi\x9B2Jthere")).toBe("hi2Jthere");
	});

	test("strips bare ESC (0x1b) not followed by a CSI intro", () => {
		// A bare ESC without the `[` intro byte is still a control — the
		// C0 pass catches it even if the CSI regex doesn't match.
		expect(stripAnsi("x\x1by")).toBe("xy");
	});

	test("passes through plain text unchanged", () => {
		expect(stripAnsi("plain text — no escapes")).toBe(
			"plain text — no escapes",
		);
		expect(stripAnsi("")).toBe("");
	});

	test("idempotent on already-clean input", () => {
		const clean = "no escapes here";
		expect(stripAnsi(stripAnsi(clean))).toBe(clean);
	});
});

describe("summarizeToolArgs — sanitizes ANSI before truncating", () => {
	test("read tool with ANSI in path produces clean output", () => {
		const summary = summarizeToolArgs("read", {
			path: "\x1b[2Joverwritten/\x1b[31mred\x1b[0m/foo.md",
		});
		// All escape sequences gone — only the file path characters remain.
		expect(summary).not.toContain("\x1b");
		expect(summary).toContain("overwritten/");
		expect(summary).toContain("foo.md");
	});

	test("update_sidebar with control bytes in id produces clean output", () => {
		const summary = summarizeToolArgs("update_sidebar", {
			operation: "upsert",
			id: "sec\x00\x07id",
		});
		expect(summary).toBe('upsert "secid"');
	});

	test("unknown tool JSON fallback also sanitized", () => {
		// Args go through JSON.stringify; ANSI bytes survive that as
		// literal `\u001b` escapes in the JSON output, NOT as actual
		// ESC bytes. So the output stays harmless without sanitization.
		const summary = summarizeToolArgs("unknown_tool", {
			value: "\x1b[31mhi\x1b[0m",
		});
		expect(summary).not.toContain("\x1b");
	});
});

describe("openVaultFilePart — rejects symlinks", () => {
	// The preload set up `Articles/sneak.md → /etc/hosts`.
	// We verify openVaultFilePart surfaces an error page instead of
	// following the link.
	const SCRATCH = mkdtempSync(join(tmpdir(), "inkstone-file-part-"));

	afterAll(() => {
		rmSync(SCRATCH, { recursive: true, force: true });
	});

	// CRITICAL: the secondary-page signal is module-global. Without
	// cleanup between tests (and especially between test FILES), a
	// leftover error page from this file would stick on the render
	// stack for every downstream TUI test and fail their waitForFrame
	// assertions. Close after each case.
	afterEach(async () => {
		const { closeSecondaryPage } = await import("@tui/context/secondary-page");
		closeSecondaryPage();
	});

	test("click on a symlinked file chip opens error page, not target content", async () => {
		const { openVaultFilePart } = await import("@tui/util/file-part-handler");
		const { getSecondaryPage } = await import("@tui/context/secondary-page");

		openVaultFilePart({
			type: "file",
			mime: "text/markdown",
			filename: "010 RAW/013 Articles/sneak.md",
		});

		const page = getSecondaryPage();
		expect(page).toBeDefined();
		expect(page?.content).toContain("Cannot open");
		expect(page?.content).not.toContain("localhost");
		expect(page?.content).not.toContain("127.0.0.1");
	});

	test("click on a regular vault file still works", async () => {
		// Seed a regular file inside a scratch dir under VAULT, NOT
		// inside `Articles/` — that directory is walked by
		// `recommendArticles` in the permissions test suite, and
		// polluting it would fail those tests. The scratch subtree
		// is orthogonal to every other test file.
		const scratchSubdir = join(VAULT, "090 SCRATCH", "ui-hardening");
		if (!existsSync(scratchSubdir))
			mkdirSync(scratchSubdir, { recursive: true });
		writeFileSync(join(scratchSubdir, "regular.md"), "# Regular content");

		const { openVaultFilePart } = await import("@tui/util/file-part-handler");
		const { getSecondaryPage } = await import("@tui/context/secondary-page");

		openVaultFilePart({
			type: "file",
			mime: "text/markdown",
			filename: "090 SCRATCH/ui-hardening/regular.md",
		});

		const page = getSecondaryPage();
		expect(page?.content).toBe("# Regular content");
		expect(page?.title).toBe("090 SCRATCH/ui-hardening/regular.md");
	});

	test("click on an inside-vault symlink to an outside-vault file is rejected", async () => {
		// Distinct from the preload's `sneak.md → /etc/hosts` case: we
		// create a symlink inside VAULT pointing at an arbitrary file
		// OUTSIDE the vault to confirm the reject fires on any symlink
		// regardless of target. Place it in the scratch subtree (not
		// Articles/) so `recommendArticles` doesn't see it.
		const outside = join(SCRATCH, "target.md");
		writeFileSync(outside, "# Outside vault");
		const scratchSubdir = join(VAULT, "090 SCRATCH", "ui-hardening");
		if (!existsSync(scratchSubdir))
			mkdirSync(scratchSubdir, { recursive: true });
		const linkName = join(scratchSubdir, "link-outside.md");
		// Remove any stale symlink from a prior test run.
		try {
			rmSync(linkName);
		} catch {
			// ignore missing file
		}
		symlinkSync(outside, linkName);

		const { openVaultFilePart } = await import("@tui/util/file-part-handler");
		const { getSecondaryPage } = await import("@tui/context/secondary-page");

		openVaultFilePart({
			type: "file",
			mime: "text/markdown",
			filename: "090 SCRATCH/ui-hardening/link-outside.md",
		});

		const page = getSecondaryPage();
		expect(page?.content).toContain("Cannot open");
		expect(page?.content).not.toContain("Outside vault");
	});

	test("path traversal with `..` is caught by isInsideDir before lstat", async () => {
		// resolve(VAULT, "../outside.md") produces a path outside VAULT,
		// which isInsideDir rejects. Guards against filenames stored in
		// old DisplayPart rows (or a future producer) that don't
		// pre-validate the escape.
		const { openVaultFilePart } = await import("@tui/util/file-part-handler");
		const { getSecondaryPage } = await import("@tui/context/secondary-page");

		openVaultFilePart({
			type: "file",
			mime: "text/markdown",
			filename: "../outside.md",
		});

		const page = getSecondaryPage();
		expect(page?.content).toContain("Path outside vault");
	});
});
