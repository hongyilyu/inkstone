import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Shared XDG-style paths + filesystem primitives for Inkstone's
 * persisted state.
 *
 * `config.ts` and `auth.ts` both need the config dir; the SQLite session
 * store uses the state dir. Centralizing here keeps the XDG fallback
 * logic and the "how do we write to the config dir safely?" primitives
 * in one place, so config/auth writers can't drift on directory mode or
 * write atomicity.
 */

const HOME = process.env.HOME ?? homedir();

export const CONFIG_DIR = join(
	process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"),
	"inkstone",
);

export const STATE_DIR = join(
	process.env.XDG_STATE_HOME ?? join(HOME, ".local", "state"),
	"inkstone",
);

export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const AUTH_FILE = join(CONFIG_DIR, "auth.json");
export const DB_FILE = join(STATE_DIR, "inkstone.db");

/**
 * Ensure `CONFIG_DIR` exists with mode 0700. Idempotent — `mkdir -p`
 * semantics don't tighten the mode of a pre-existing directory (e.g.
 * one created by an earlier writer with the default 0755), so we
 * always `chmodSync` to be safe. `chmod` is best-effort: on Windows
 * or exotic filesystems it can fail; swallowed rather than thrown
 * because the dir itself is still usable.
 *
 * Closes the H4 hazard where `config.ts`'s `saveConfig` (default
 * umask → 0755) and `auth.ts`'s `saveKiroCreds` (explicit 0700)
 * would race to create the directory, and whichever won left the
 * other's expectations violated.
 */
export function ensureConfigDir(): void {
	mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	try {
		chmodSync(CONFIG_DIR, 0o700);
	} catch {
		// best-effort on Windows / exotic filesystems
	}
}

/**
 * Write a file atomically with the specified mode. Writes to a tmp
 * sibling via `"wx"` (= `O_CREAT | O_EXCL | O_WRONLY`; the `O_TRUNC`
 * Node adds is harmless because `O_EXCL` guarantees the file doesn't
 * exist). Mode is honored on creation, so the bytes never hit disk at
 * a looser mode. `fsync`s the fd to flush kernel buffers, closes,
 * renames atomically, and `fsync`s the parent directory so the
 * rename itself is durable — otherwise a crash between rename and
 * the next directory-journal commit could leave `dest` pointing at a
 * zero-length inode on some filesystems.
 *
 * On intra-process error (ENOSPC / EIO on `writeSync` or `fsyncSync`),
 * unlinks the tmp file before rethrowing so a transient failure
 * doesn't leave a permanent orphan that would `EEXIST`-block every
 * subsequent save. The `O_EXCL` "detect prior-crash orphan" behavior
 * still applies to orphans left by a *prior* process invocation —
 * those fail loudly, which is the intended signal.
 *
 * Closes H2 (non-atomic overwrite losing content on crash), H3
 * (mode-tightening race during the 0644 → 0600 window), and the
 * parent-dir durability edge of H2.
 */
export function writeFileAtomic(
	dest: string,
	data: string,
	mode: number,
): void {
	const tmp = `${dest}.tmp`;
	// `openSync` with `"wx"` throws `EEXIST` on an orphan from a prior
	// process invocation; we propagate that loudly rather than
	// clobbering (there's nothing to clean up — we didn't create the
	// orphan). Intra-process write/rename failures have their own
	// unlink branches below.
	const fd = openSync(tmp, "wx", mode);
	try {
		// `writeSync(fd, data)` returns the number of bytes written;
		// it is NOT guaranteed to write the full string in one call.
		// On ENOSPC (disk full) POSIX `write(2)` returns a short count
		// without throwing, so we have to loop until fully written. A
		// partial write followed by fsync + rename would commit a
		// truncated file to `dest` and break the atomicity contract.
		const buf = Buffer.from(data);
		let offset = 0;
		while (offset < buf.length) {
			const written = writeSync(fd, buf, offset, buf.length - offset);
			if (written <= 0) {
				throw new Error(
					`short write to ${tmp} (${offset}/${buf.length} bytes)`,
				);
			}
			offset += written;
		}
		fsyncSync(fd);
		closeSync(fd);
	} catch (err) {
		// Write or fsync failed mid-flight. Close the fd (best-effort)
		// and unlink the tmp so a subsequent save isn't permanently
		// wedged on EEXIST. Then rethrow so the caller's existing
		// `reportPersistenceError` catch can surface the toast.
		try {
			closeSync(fd);
		} catch {
			// fd may already be closed if closeSync threw above.
		}
		try {
			unlinkSync(tmp);
		} catch {
			// unlink races; caller will see the original error anyway.
		}
		throw err;
	}
	try {
		renameSync(tmp, dest);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// see above
		}
		throw err;
	}
	// Durability for the rename itself. Flushes the parent dir's
	// metadata journal entry so a crash doesn't leave `dest` pointing
	// at a zero-length inode on filesystems with lax metadata ordering.
	try {
		const dirFd = openSync(dirname(dest), "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch {
		// Parent-dir fsync is best-effort: on Windows or exotic FSes
		// the open-dir-as-file dance may not work. The rename already
		// succeeded; caller sees a durable-ish file either way.
	}
}
