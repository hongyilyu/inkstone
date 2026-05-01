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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VAULT_DIR } from "@backend/agent/constants";
import { isInsideDir } from "@backend/agent/permissions";
import type { DisplayPart } from "@bridge/view-model";
import { openSecondaryPage } from "../context/secondary-page";

type FilePart = Extract<DisplayPart, { type: "file" }>;

/**
 * Resolve `part.filename` against `VAULT_DIR`, path-string sandbox-check
 * that the resolved path is inside the vault, read the file, and open
 * its content in the secondary page. On any failure (outside-vault,
 * missing file, I/O error), open the secondary page with a short error
 * note so the click is never silent.
 *
 * The sandbox is a string-level check — it does NOT follow symlinks, so
 * a symlink *inside* the vault that points outside would be followed by
 * `readFileSync`. `readFileSafe` in `mentions.ts` closes that hole on the
 * write-side (prompt expansion) via `lstatSync`. The asymmetry predates
 * this extraction; threat model justifies deferring a matching guard
 * here (file parts arrive from agent output or `@`-mention expansion,
 * both of which already apply the write-side guard before stamping a
 * `file` part). Revisit if a producer lands that emits `file` parts
 * pointing at paths it hasn't pre-validated.
 */
export function openVaultFilePart(part: FilePart): void {
	const { filename } = part;
	try {
		const abs = resolve(VAULT_DIR, filename);
		if (!isInsideDir(abs, VAULT_DIR) || abs === VAULT_DIR) {
			openSecondaryPage({ content: `_Path outside vault: ${filename}_` });
			return;
		}
		const content = readFileSync(abs, "utf-8");
		openSecondaryPage({ content, title: filename });
	} catch {
		openSecondaryPage({ content: `_Could not read file: ${filename}_` });
	}
}
