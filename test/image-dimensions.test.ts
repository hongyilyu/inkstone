/**
 * Header-only PNG and JPEG dimension readers — tests for
 * `src/tui/util/image-dimensions.ts`.
 *
 * Corpus is `.jpg` + `.png` only (Obsidian export, 351 wikilinks across 65
 * articles, no GIF/WebP). Other formats deferred. Failure mode for any
 * unrecognised header is `null` so the secondary-page renderable can fall
 * through to its text-error path.
 *
 * Inputs are `Buffer` (we read with `readFileSync` returning a `Buffer`
 * directly; no base64 round-trip, unlike pi-mono's reference shape).
 */

import { describe, expect, test } from "bun:test";
import {
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
} from "../src/tui/util/image-dimensions";

// ---------------------------------------------------------------------------
// Fixture builders. We construct the headers byte-by-byte rather than
// checking in real images because (a) the diff stays text-only and
// reviewable, and (b) we exercise the exact byte offsets the parser reads.
// ---------------------------------------------------------------------------

/** A 4×4 PNG header. We don't need a valid IDAT chunk — the parser only
 *  reads the IHDR width/height at offsets 16/20. */
function buildPng(width: number, height: number): Buffer {
	const buf = Buffer.alloc(24);
	// PNG signature: 89 50 4E 47 0D 0A 1A 0A
	buf[0] = 0x89;
	buf[1] = 0x50;
	buf[2] = 0x4e;
	buf[3] = 0x47;
	buf[4] = 0x0d;
	buf[5] = 0x0a;
	buf[6] = 0x1a;
	buf[7] = 0x0a;
	// IHDR chunk: length(4) "IHDR"(4) width(4) height(4) [...]
	buf.writeUInt32BE(13, 8); // chunk length
	buf.write("IHDR", 12, "ascii");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

/** A minimal JPEG with SOI + SOF0. SOF0's 5th payload byte is height
 *  hi-byte, the parser reads height at offset+5/6 and width at +7/8. */
function buildJpeg(width: number, height: number): Buffer {
	// SOI(2) + SOF0 marker(2) + length(2) + precision(1) + height(2) + width(2)
	//        + components(1) + 3*component-spec(3) = 2+2+2+1+2+2+1+9 = 21
	const buf = Buffer.alloc(21);
	buf[0] = 0xff;
	buf[1] = 0xd8; // SOI
	buf[2] = 0xff;
	buf[3] = 0xc0; // SOF0
	buf.writeUInt16BE(17, 4); // segment length (precision + height + width + nf + components)
	buf[6] = 8; // precision
	buf.writeUInt16BE(height, 7);
	buf.writeUInt16BE(width, 9);
	buf[11] = 3; // component count
	// 9 trailing bytes are zero-init component specs; parser doesn't read them.
	return buf;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

describe("getPngDimensions", () => {
	test("4x4 PNG → {4, 4}", () => {
		expect(getPngDimensions(buildPng(4, 4))).toEqual({
			widthPx: 4,
			heightPx: 4,
		});
	});

	test("non-square PNG → exact dims", () => {
		expect(getPngDimensions(buildPng(1920, 1080))).toEqual({
			widthPx: 1920,
			heightPx: 1080,
		});
	});

	test("buffer too short → null", () => {
		expect(getPngDimensions(Buffer.alloc(20))).toBeNull();
	});

	test("wrong signature → null", () => {
		const buf = buildPng(4, 4);
		buf[0] = 0x00; // corrupt the magic number
		expect(getPngDimensions(buf)).toBeNull();
	});

	test("empty buffer → null", () => {
		expect(getPngDimensions(Buffer.alloc(0))).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

describe("getJpegDimensions", () => {
	test("SOF0 marker → exact dims", () => {
		expect(getJpegDimensions(buildJpeg(800, 600))).toEqual({
			widthPx: 800,
			heightPx: 600,
		});
	});

	test("SOF2 (progressive) marker still parsed", () => {
		const buf = buildJpeg(640, 480);
		buf[3] = 0xc2; // swap SOF0 → SOF2; parser handles 0xC0–0xC2
		expect(getJpegDimensions(buf)).toEqual({
			widthPx: 640,
			heightPx: 480,
		});
	});

	test("buffer too short → null", () => {
		expect(getJpegDimensions(Buffer.alloc(1))).toBeNull();
	});

	test("non-JPEG signature → null", () => {
		expect(getJpegDimensions(Buffer.from([0x00, 0x00, 0x00]))).toBeNull();
	});

	test("missing SOF marker → null", () => {
		// Valid SOI but never reaches a SOF0–SOF2 marker before EOF.
		const buf = Buffer.alloc(20);
		buf[0] = 0xff;
		buf[1] = 0xd8;
		// fill with non-FF bytes so the scan walks to EOF without finding 0xFF
		for (let i = 2; i < buf.length; i++) buf[i] = 0x10;
		expect(getJpegDimensions(buf)).toBeNull();
	});

	test("APPn segment skipped to reach SOF0", () => {
		// SOI + APP0 (length=8, payload zeroed) + SOF0(800×600).
		// Exercises the `offset += 2 + length` segment-skip path that
		// the bare-EOF case above doesn't reach.
		const sof = buildJpeg(800, 600);
		const app0 = Buffer.alloc(10);
		app0[0] = 0xff;
		app0[1] = 0xe0; // APP0
		app0.writeUInt16BE(8, 2); // length includes itself; 8 = length(2) + payload(6)
		// payload bytes 4..9 stay zero; parser doesn't read them.
		const buf = Buffer.concat([sof.subarray(0, 2), app0, sof.subarray(2)]);
		expect(getJpegDimensions(buf)).toEqual({ widthPx: 800, heightPx: 600 });
	});

	test("truncated buffer mid-segment-length → null", () => {
		// SOI + 0xFF + APP0 marker but EOF before the 2-byte length field.
		const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
		expect(getJpegDimensions(buf)).toBeNull();
	});

	test("malformed length=1 segment → null", () => {
		// Spec says segment length must be ≥ 2 (the field includes itself).
		// A length=1 segment is malformed; parser should bail rather than
		// loop forever on `offset += 2 + length`.
		const buf = Buffer.alloc(20);
		buf[0] = 0xff;
		buf[1] = 0xd8;
		buf[2] = 0xff;
		buf[3] = 0xe0; // APP0
		buf.writeUInt16BE(1, 4); // length = 1, illegal
		expect(getJpegDimensions(buf)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Dispatch helper
// ---------------------------------------------------------------------------

describe("getImageDimensions (mime dispatch)", () => {
	test("image/png routes to PNG reader", () => {
		expect(getImageDimensions(buildPng(8, 16), "image/png")).toEqual({
			widthPx: 8,
			heightPx: 16,
		});
	});

	test("image/jpeg routes to JPEG reader", () => {
		expect(getImageDimensions(buildJpeg(320, 240), "image/jpeg")).toEqual({
			widthPx: 320,
			heightPx: 240,
		});
	});

	test("unknown mime → null", () => {
		expect(getImageDimensions(buildPng(8, 8), "image/gif")).toBeNull();
	});
});
