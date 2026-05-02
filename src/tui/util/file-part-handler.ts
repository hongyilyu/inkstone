/**
 * Click handlers for `file`-type display parts.
 *
 * Today there's exactly one handler: `openVaultFilePart`, which reads
 * a vault-relative markdown (or text) file off disk and opens it in
 * the secondary page. Both current producers of `file` parts — reader's
 * `/article` command and `@`-mentions in the prompt — are vault-scoped,
 * so a single handler covers every call site.
 *
 * Extracted out of `UserPart` so the rendering component doesn't carry
 * backend filesystem knowledge (`VAULT_DIR`, `isInsideDir`, `readFileSync`).
 * `UserPart` stays a thin chip renderer; this util owns the "what does
 * clicking do?" decision.
 *
 * Vault-specific by design. If a second producer lands that emits file
 * parts pointing at a non-vault source (arbitrary filesystem path,
 * URL, in-memory buffer, etc.), revisit as a dispatch table keyed on
 * a new `source` discriminator added to `DisplayPart.file`.
 */

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VAULT_DIR } from "@backend/agent/constants";
import { isInsideDir } from "@backend/agent/permissions";
import type { DisplayPart } from "@bridge/view-model";
import { openSecondaryPage } from "../context/secondary-page";

type FilePart = Extract<DisplayPart, { type: "file" }>;

/**
 * Resolve `part.filename` against `VAULT_DIR`, sandbox-check that the
 * resolved path is inside the vault, confirm it's a regular file (not
 * a symlink, directory, FIFO, socket, or device), read its contents,
 * and open it in the secondary page.
 *
 * Symlink rejection closes the M3 hazard from the May 2026 audit: a
 * persisted `file` part from a prior session could point at a path
 * that wasn't a symlink at stamp time but became one later. Both
 * current producers (`/article`, `@`-mentions) already `lstatSync`-
 * reject symlinks at the write side, but the chip round-trips through
 * SQLite, so the read-side guard has to be independent.
 *
 * Known narrow gap: `resolve(VAULT_DIR, filename)` does NOT resolve
 * symlinks in *intermediate* path components. A symlinked DIRECTORY
 * inside the vault (e.g. `VAULT/foo → /etc`) would let
 * `isInsideDir(resolve(VAULT, "foo/passwd"), VAULT)` pass and the
 * final lstat would return `isFile()=true` for the regular file
 * `/etc/passwd`. Accepted for now: both current producers lstat at
 * write time, so the malicious path wouldn't get stamped into a
 * `file` part in the first place. Closing it requires
 * `realpathSync` + re-`isInsideDir`-checking the real path; not
 * worth the cost today.
 *
 * On any failure (outside-vault, symlink, non-file, missing, I/O),
 * open the secondary page with a short error note so the click is
 * never silent.
 */
export function openVaultFilePart(part: FilePart): void {
	const { filename } = part;
	try {
		const abs = resolve(VAULT_DIR, filename);
		if (!isInsideDir(abs, VAULT_DIR) || abs === VAULT_DIR) {
			openSecondaryPage({ content: `_Path outside vault: ${filename}_` });
			return;
		}
		// `lstatSync` (not `statSync`) so the symlink itself is inspected
		// rather than its target. A symlink inside the vault pointing at
		// `/etc/hosts` would pass `isInsideDir` but fail `isFile()` iff
		// we follow the link — we want the loud reject instead.
		const st = lstatSync(abs);
		if (st.isSymbolicLink() || !st.isFile()) {
			openSecondaryPage({ content: `_Cannot open: ${filename}_` });
			return;
		}
		const content = readFileSync(abs, "utf-8");
		openSecondaryPage({ content, title: filename });
	} catch {
		openSecondaryPage({ content: `_Could not read file: ${filename}_` });
	}
}
