import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { Sink } from "./index";

/**
 * Append-mode file sink. Opens once at construction; flushes per write.
 * On stream errors, swallows silently — the logger must never take down
 * the host process. (Logging the failure would be circular.)
 */
export interface FileSink extends Sink {
	close(): Promise<void>;
}

export function fileSink(path: string): FileSink {
	mkdirSync(dirname(path), { recursive: true });
	const stream: WriteStream = createWriteStream(path, { flags: "a" });
	stream.on("error", () => {
		// Suppress to keep logging non-fatal.
	});
	return {
		write(line) {
			stream.write(`${line}\n`);
		},
		close() {
			return new Promise<void>((resolve) => {
				stream.end(() => resolve());
			});
		},
	};
}
