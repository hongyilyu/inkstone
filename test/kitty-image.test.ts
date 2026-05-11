/**
 * Pure helpers behind `KittyImageRenderable`.
 *
 * The renderable itself runs inside OpenTUI's mount tree and writes
 * U+10EEEE placeholder cells through `OptimizedBuffer.drawText` — we
 * cover that integration in PR3 once the renderable is wired through
 * the secondary page's `<markdown renderNode=...>` hook. This file
 * pins the protocol bytes and the pieces of the lifecycle that are
 * decidable outside a render loop:
 *
 *   - the Kitty graphics upload payload framing (`a=t,U=1,...`),
 *   - the placeholder-cell encoding (image id → fg RGB; row → diacritic),
 *   - the per-path image-id cache (re-mount of the same article doesn't
 *     re-allocate or re-upload).
 *
 * Sandbox + fallback paths reuse the same helpers as `openVaultFilePart`
 * (`src/tui/util/file-part-handler.ts:58-80`) — those are tested at the
 * file-handler layer, so no need to re-test the path-resolve seam here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	__test__,
	encodeKittyUpload,
	getOrAllocateImageId,
	placeholderCell,
	resolveImageSource,
} from "../src/tui/components/kitty-image";

afterEach(() => {
	__test__.resetIdCache();
});

// ---------------------------------------------------------------------------
// Upload payload framing
// ---------------------------------------------------------------------------

describe("encodeKittyUpload", () => {
	test("short payload → single chunk with q=2,a=t,U=1,f=100", () => {
		const out = encodeKittyUpload("YWJj", 7); // base64 of "abc"
		expect(out.startsWith("\x1b_G")).toBe(true);
		// Trailing ESC \\ (string-terminator).
		expect(out.endsWith("\x1b\\")).toBe(true);
		// Required parameters per Kitty spec for transmit-only upload that
		// will later be addressed via Unicode placeholders.
		expect(out).toContain("a=t");
		expect(out).toContain("U=1");
		expect(out).toContain("f=100");
		expect(out).toContain("q=2");
		expect(out).toContain("i=7");
		// Single-chunk path doesn't carry an `m=...` flag.
		expect(out).not.toContain("m=0");
		expect(out).not.toContain("m=1");
		// Payload after the `;` separator.
		expect(out).toContain(";YWJj\x1b\\");
	});

	test("long payload → multi-chunk with m=1 markers and m=0 terminator", () => {
		// 4097 base64 chars → triggers chunking (CHUNK_SIZE = 4096).
		const big = "A".repeat(5000);
		const out = encodeKittyUpload(big, 42);

		// First chunk carries the param block + `m=1`.
		expect(out).toContain("a=t");
		expect(out).toContain("U=1");
		expect(out).toContain("i=42");
		// At least one `m=1` (continuation) and exactly one `m=0` (final).
		expect(out.includes("m=1")).toBe(true);
		expect((out.match(/m=0/g) ?? []).length).toBe(1);
		// Multi-chunk output is concatenated escape sequences — must end
		// with the trailing ST.
		expect(out.endsWith("\x1b\\")).toBe(true);
	});

	test("image id is rendered as base-10 in the i= parameter", () => {
		const out = encodeKittyUpload("YQ==", 256);
		expect(out).toContain("i=256");
	});
});

// ---------------------------------------------------------------------------
// Placeholder-cell encoding (image id → fg RGB; row → diacritic combiner)
// ---------------------------------------------------------------------------

describe("placeholderCell", () => {
	test("character is U+10EEEE", () => {
		const cell = placeholderCell({ imageId: 1, row: 0 });
		// JS strings are UTF-16; U+10EEEE is a surrogate pair, length 2.
		expect(cell.char.length).toBe(2);
		expect(cell.char.codePointAt(0)).toBe(0x10eeee);
	});

	test("image id → fg RGB triplet (high, mid, low byte)", () => {
		// id = 0x0A0B0C → R=10, G=11, B=12
		const cell = placeholderCell({ imageId: 0x0a0b0c, row: 0 });
		expect(cell.fgR).toBe(10);
		expect(cell.fgG).toBe(11);
		expect(cell.fgB).toBe(12);
	});

	test("small id puts the value entirely in the blue channel", () => {
		const cell = placeholderCell({ imageId: 7, row: 0 });
		expect(cell.fgR).toBe(0);
		expect(cell.fgG).toBe(0);
		expect(cell.fgB).toBe(7);
	});

	test("row 0 → diacritic for index 0; row 4 → diacritic for index 4", () => {
		// The Kitty placeholder spec uses a fixed 297-codepoint diacritic
		// table; the contract for our renderable is just that distinct
		// rows map to distinct combiners, and the table starts at the
		// canonical first entry (U+0305, COMBINING OVERLINE).
		const r0 = placeholderCell({ imageId: 1, row: 0 });
		const r4 = placeholderCell({ imageId: 1, row: 4 });
		expect(r0.rowDiacritic).not.toBe(r4.rowDiacritic);
		expect(r0.rowDiacritic.codePointAt(0)).toBe(0x0305);
	});
});

// ---------------------------------------------------------------------------
// Per-path image-id cache
// ---------------------------------------------------------------------------

describe("getOrAllocateImageId", () => {
	test("same path → same id across calls (no re-allocation)", () => {
		const a = getOrAllocateImageId("/vault/foo.png");
		const b = getOrAllocateImageId("/vault/foo.png");
		expect(a).toBe(b);
	});

	test("distinct paths → distinct sequential ids", () => {
		const a = getOrAllocateImageId("/vault/a.png");
		const b = getOrAllocateImageId("/vault/b.png");
		expect(a).not.toBe(b);
		// Sequential allocator: the second id should be exactly one more.
		expect(b).toBe(a + 1);
	});

	test("ids start at 1 (Kitty rejects i=0)", () => {
		const id = getOrAllocateImageId("/vault/first.png");
		expect(id).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// File source resolution (sandbox + format sniff + missing-file path)
// ---------------------------------------------------------------------------

describe("resolveImageSource", () => {
	test("file outside vault → fallback reason 'outside vault'", () => {
		const r = resolveImageSource("../../../etc/passwd");
		expect(r.kind).toBe("error");
		if (r.kind === "error") {
			expect(r.reason).toMatch(/outside vault/i);
		}
	});

	test("missing file → fallback reason 'not found'", () => {
		const r = resolveImageSource("nonexistent/path/foo.png");
		expect(r.kind).toBe("error");
		if (r.kind === "error") {
			expect(r.reason).toMatch(/not found/i);
		}
	});
});
