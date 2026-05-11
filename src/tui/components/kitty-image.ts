/**
 * Kitty graphics image renderable for the secondary-page reader.
 *
 * Renders Obsidian-vault images inline inside the article markdown using
 * the Kitty graphics protocol's Unicode-placeholder mode (target terminal
 * is Ghostty). The terminal — not the TUI — composites the image over
 * the placeholder cells we paint into `OptimizedBuffer`, so the picture
 * survives OpenTUI's per-frame cell repaint without per-frame escape
 * re-emission.
 *
 * Lifecycle:
 *   1. `resolveImageSource(href)` resolves the wikilink path against the
 *      vault, sandbox-checks (matching `openVaultFilePart`), reads bytes,
 *      sniffs PNG/JPEG and decodes intrinsic pixel dims.
 *   2. `getOrAllocateImageId(absPath)` reuses an existing id when the
 *      same article re-mounts (caching is process-lifetime; Ghostty
 *      reclaims when the TUI exits).
 *   3. First `renderSelf` issues `encodeKittyUpload(...)` to stdout
 *      (transmit-only; placement is via the placeholder cells we draw
 *      into the buffer).
 *   4. Every `renderSelf` paints `placeholderCell` rows into the buffer.
 *
 * Failure paths (path outside vault, missing, symlink, unsupported
 * format, terminal can't speak Kitty graphics) all fall through to a
 * one-line text fallback so the article keeps reading.
 */

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VAULT_DIR } from "@backend/agent/constants";
import { isInsideDir } from "@backend/agent/permissions";
import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { Renderable, type RenderableOptions, RGBA } from "@opentui/core";
import {
	getImageDimensions,
	type ImageDimensions,
} from "../util/image-dimensions";

// ---------------------------------------------------------------------------
// Cell-pixel constants. Ghostty's default cell is 9×18 px on a typical
// HiDPI macOS setup. We don't query `\x1b[14t` at boot — the user is
// Ghostty-only and the static value is good enough for layout. If users
// run with extreme zoom levels and images render visibly off-aspect, this
// is the knob.
// ---------------------------------------------------------------------------

const CELL_WIDTH_PX = 9;
const CELL_HEIGHT_PX = 18;

// ---------------------------------------------------------------------------
// Image-id cache. Sequential allocator from 1 (Kitty rejects i=0). The
// cache lives for the process lifetime — re-opening the same article
// does not re-upload bytes Ghostty already holds.
// ---------------------------------------------------------------------------

const idByPath = new Map<string, number>();
let nextId = 1;

export function getOrAllocateImageId(absPath: string): number {
	const cached = idByPath.get(absPath);
	if (cached !== undefined) return cached;
	const id = nextId++;
	idByPath.set(absPath, id);
	return id;
}

// ---------------------------------------------------------------------------
// Source resolution. Same shape as `openVaultFilePart` for the sandbox
// check — vault-relative path → absolute → `isInsideDir` → `lstatSync`
// reject symlinks. Returns a discriminated union so the renderable can
// pick its happy/error branch without exception flow.
// ---------------------------------------------------------------------------

export type ImageSource =
	| {
			kind: "ok";
			absPath: string;
			bytes: Buffer;
			mimeType: "image/png" | "image/jpeg";
			dims: ImageDimensions;
	  }
	| { kind: "error"; reason: string };

function sniffMimeType(buf: Buffer): "image/png" | "image/jpeg" | null {
	if (buf.length < 4) return null;
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
		return "image/png";
	if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
	return null;
}

export function resolveImageSource(relPath: string): ImageSource {
	let absPath: string;
	try {
		absPath = resolve(VAULT_DIR, decodeURI(relPath));
	} catch {
		return { kind: "error", reason: "invalid path" };
	}
	if (!isInsideDir(absPath, VAULT_DIR) || absPath === VAULT_DIR) {
		return { kind: "error", reason: "outside vault" };
	}
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(absPath);
	} catch {
		return { kind: "error", reason: "not found" };
	}
	if (stat.isSymbolicLink() || !stat.isFile()) {
		return { kind: "error", reason: "not a regular file" };
	}
	let bytes: Buffer;
	try {
		bytes = readFileSync(absPath);
	} catch {
		return { kind: "error", reason: "read failed" };
	}
	const mimeType = sniffMimeType(bytes);
	if (!mimeType) {
		return { kind: "error", reason: "unsupported format" };
	}
	const dims = getImageDimensions(bytes, mimeType);
	if (!dims) {
		return { kind: "error", reason: "unsupported format" };
	}
	return { kind: "ok", absPath, bytes, mimeType, dims };
}

// ---------------------------------------------------------------------------
// Kitty graphics upload encoding. Transmit-only (`a=t`) so the image is
// stored under id `i=...` for later reference via Unicode placeholders
// (`U=1` is required for that addressing mode). Chunked at 4 KB.
//
// `q=2` (silent — no success or failure replies). We deliberately discard
// errors: the corpus is hand-curated valid PNG/JPEG, OpenTUI owns stdin so
// any reply Kitty wrote there could collide with input parsing, and the
// fallback for a failed upload (blank placeholder cells) is no worse than
// the no-image baseline a non-Ghostty terminal would already render. If
// uploads start failing in the wild, swap to `q=1` (errors only) and add
// a stderr-logged drain.
// ---------------------------------------------------------------------------

const UPLOAD_CHUNK_SIZE = 4096;

export function encodeKittyUpload(base64Data: string, imageId: number): string {
	const params = `a=t,U=1,f=100,q=2,i=${imageId}`;

	if (base64Data.length <= UPLOAD_CHUNK_SIZE) {
		return `\x1b_G${params};${base64Data}\x1b\\`;
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;
	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + UPLOAD_CHUNK_SIZE);
		const isLast = offset + UPLOAD_CHUNK_SIZE >= base64Data.length;
		if (isFirst) {
			chunks.push(`\x1b_G${params},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}
		offset += UPLOAD_CHUNK_SIZE;
	}
	return chunks.join("");
}

// ---------------------------------------------------------------------------
// Placeholder-cell encoding.
//
// The Kitty Unicode placeholder protocol addresses an uploaded image by
// painting `U+10EEEE` cells at the desired screen position. The image id
// rides in the cell foreground RGB channels (R = high byte, G = mid, B =
// low). The row index within the image is encoded as a combining
// diacritic following the placeholder character; the table starts at
// U+0305 (COMBINING OVERLINE) and runs through 297 glyphs.
//
// We only need a handful of distinct rows (image heights in cells), so
// we precompute the diacritic prefix lazily.
// ---------------------------------------------------------------------------

// First 32 entries of Kitty's diacritic table — covers any image up to
// ~600 px tall on a 9×18 cell, which more than covers our corpus. Source:
// https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
const ROW_DIACRITICS: number[] = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346,
	0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363,
	0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c,
	0x036d, 0x036e, 0x036f, 0x0483, 0x0484,
];

const PLACEHOLDER_CHAR = String.fromCodePoint(0x10eeee);

export interface PlaceholderCell {
	char: string;
	rowDiacritic: string;
	fgR: number;
	fgG: number;
	fgB: number;
}

export function placeholderCell(opts: {
	imageId: number;
	row: number;
}): PlaceholderCell {
	const id = opts.imageId;
	const fgR = (id >>> 16) & 0xff;
	const fgG = (id >>> 8) & 0xff;
	const fgB = id & 0xff;
	const cp = ROW_DIACRITICS[opts.row] ?? ROW_DIACRITICS[0];
	return {
		char: PLACEHOLDER_CHAR,
		rowDiacritic: String.fromCodePoint(cp),
		fgR,
		fgG,
		fgB,
	};
}

// ---------------------------------------------------------------------------
// Renderable
// ---------------------------------------------------------------------------

export interface KittyImageOptions
	extends RenderableOptions<KittyImageRenderable> {
	href: string;
	alt?: string;
	/**
	 * Notification fired whenever the renderable computes its target
	 * row count. The host `<box>` mirrors this into its own `height`
	 * prop so flex layout reserves the right number of cell rows for
	 * the image. Without it Yoga gives the host `auto` height ≈ 0 and
	 * subsequent siblings collapse over the image.
	 */
	onLayout?: (rows: number) => void;
}

const FALLBACK_FG = RGBA.fromInts(180, 60, 60); // approx theme.error

export class KittyImageRenderable extends Renderable {
	private source: ImageSource;
	private imageId: number | null = null;
	private uploaded = false;
	private rowsCells = 1;
	private widthCells = 1;
	private fallbackText: string | null = null;
	private onLayoutCb?: (rows: number) => void;

	constructor(ctx: RenderContext, options: KittyImageOptions) {
		super(ctx, {
			...options,
			height: 1,
		});

		this.onLayoutCb = options.onLayout;
		this.source = resolveImageSource(options.href);
		if (this.source.kind === "error") {
			this.fallbackText = `[Image: ${options.href} — ${this.source.reason}]`;
			// Fallback always renders one line; report it so the host box
			// gets a non-zero height.
			this.onLayoutCb?.(1);
			return;
		}
		this.imageId = getOrAllocateImageId(this.source.absPath);
	}

	protected onResize(width: number, height: number): void {
		super.onResize(width, height);
		this.widthCells = Math.max(1, width);
		if (this.source.kind === "ok") {
			const targetPx = this.widthCells * CELL_WIDTH_PX;
			const aspect =
				this.source.dims.heightPx / Math.max(1, this.source.dims.widthPx);
			const targetHeightPx = targetPx * aspect;
			const newRows = Math.max(1, Math.ceil(targetHeightPx / CELL_HEIGHT_PX));
			if (newRows !== this.rowsCells) {
				this.rowsCells = newRows;
				this.height = newRows;
				this.onLayoutCb?.(newRows);
			}
		}
	}

	protected renderSelf(buffer: OptimizedBuffer): void {
		// `screenX/screenY` are this renderable's absolute position in the
		// buffer the parent owns; `x/y` are unresolved local coords.
		// `TextBufferRenderable.renderSelf` uses screen coords for the
		// same reason — see `node_modules/@opentui/core/.../
		// TextBufferRenderable.ts:498-502`.
		const sx = this._screenX;
		const sy = this._screenY;

		if (this.fallbackText) {
			buffer.drawText(this.fallbackText, sx, sy, FALLBACK_FG);
			return;
		}
		if (!this.visible) return;
		if (this.source.kind !== "ok" || this.imageId === null) return;

		// Upload once per (process, absPath). Same id is reused on
		// subsequent renders.
		if (!this.uploaded) {
			const base64 = this.source.bytes.toString("base64");
			process.stdout.write(encodeKittyUpload(base64, this.imageId));
			this.uploaded = true;
		}

		// Paint placeholder cells across the renderable's region. The
		// terminal composites the bound image over these cells.
		for (let row = 0; row < this.rowsCells; row++) {
			const cell = placeholderCell({ imageId: this.imageId, row });
			const fg = RGBA.fromInts(cell.fgR, cell.fgG, cell.fgB);
			const text = (cell.char + cell.rowDiacritic).repeat(this.widthCells);
			buffer.drawText(text, sx, sy + row, fg);
		}
	}
}

// ---------------------------------------------------------------------------
// Test-only hooks. Reset the id cache between tests so allocation order
// is deterministic. Not part of the public surface.
// ---------------------------------------------------------------------------

export const __test__ = {
	resetIdCache(): void {
		idByPath.clear();
		nextId = 1;
	},
};
