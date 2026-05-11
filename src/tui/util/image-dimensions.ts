/**
 * Header-only PNG and JPEG dimension readers.
 *
 * Used by the secondary-page image renderable to compute target row count
 * (`ceil((contentWidthCells × cellWidthPx) / aspectRatio / cellHeightPx)`)
 * before issuing the Kitty graphics upload, so the layout reserves the
 * right number of cells. We only need the intrinsic pixel dimensions; the
 * pixel data itself rides through unparsed in the base64 payload.
 *
 * Corpus is `.jpg` + `.png` only (Obsidian export, 351 wikilinks across
 * 65 articles, no GIF/WebP). Other formats deferred — `getImageDimensions`
 * returns `null` for any unrecognised mime so the renderable can fall
 * through to its text-error path.
 *
 * Ported from `pi-mono/packages/tui/src/terminal-image.ts:221-283`. The
 * notable shape change is `Buffer` input instead of base64 string —
 * Inkstone reads with `readFileSync` returning a `Buffer` directly, so
 * the base64 round-trip in pi-mono's signature was dead weight.
 */

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export function getPngDimensions(buf: Buffer): ImageDimensions | null {
	try {
		if (buf.length < 24) return null;

		// PNG signature: 89 50 4E 47
		if (
			buf[0] !== 0x89 ||
			buf[1] !== 0x50 ||
			buf[2] !== 0x4e ||
			buf[3] !== 0x47
		) {
			return null;
		}

		// IHDR is the first chunk; width/height live at fixed offsets 16/20.
		const widthPx = buf.readUInt32BE(16);
		const heightPx = buf.readUInt32BE(20);
		return { widthPx, heightPx };
	} catch {
		return null;
	}
}

export function getJpegDimensions(buf: Buffer): ImageDimensions | null {
	try {
		if (buf.length < 2) return null;

		// SOI marker
		if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

		let offset = 2;
		while (offset < buf.length - 9) {
			if (buf[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buf[offset + 1];

			// SOF0 (0xC0) baseline / SOF1 (0xC1) extended / SOF2 (0xC2) progressive
			// all carry the same height/width offsets in their payload.
			if (marker >= 0xc0 && marker <= 0xc2) {
				const heightPx = buf.readUInt16BE(offset + 5);
				const widthPx = buf.readUInt16BE(offset + 7);
				return { widthPx, heightPx };
			}

			if (offset + 3 >= buf.length) return null;
			const length = buf.readUInt16BE(offset + 2);
			if (length < 2) return null;
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(
	buf: Buffer,
	mimeType: string,
): ImageDimensions | null {
	if (mimeType === "image/png") return getPngDimensions(buf);
	if (mimeType === "image/jpeg") return getJpegDimensions(buf);
	return null;
}
