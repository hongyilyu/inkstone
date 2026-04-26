import {
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { NOTES_DIR, SCRAPS_DIR, VAULT_DIR } from "./constants";
import { registerBaseline } from "./permissions";

/**
 * Shared tool pool. Any agent picks from here via `extraTools` (reader
 * uses `[editTool, writeTool]`; example uses `[]`); `base.ts` pulls
 * `readTool` into `BASE_TOOLS` so every agent gets it unconditionally.
 *
 * Implementations come from `@mariozechner/pi-coding-agent`:
 *   - `read`  — file read with offset/limit + image support + truncation.
 *   - `write` — overwrite-only file write; creates parent dirs; mutation-queued.
 *   - `edit`  — multi-edit unified diff; mutation-queued. Params are
 *               `{ path, edits: [{ oldText, newText }, ...] }`. The
 *               permission dispatcher iterates `args.edits[]` when the
 *               `frontmatterOnlyFor` rule fires (see `./permissions.ts`).
 *
 * `VAULT_DIR` is passed as `cwd` so vault-relative paths resolve inside
 * the vault. The factories do NOT sandbox — an absolute `/etc/passwd`
 * path would be honored by the tool itself. Sandbox enforcement lives
 * in the permission dispatcher (`./permissions.ts`) via the `insideDirs`
 * baseline rules registered below. The dispatcher mirrors
 * pi-coding-agent's own path expansion (`~` / `@`) so its sandbox check
 * cannot disagree with the tool's resolution.
 *
 * The factories return tool objects whose `renderCall` / `renderResult`
 * hooks reference `@mariozechner/pi-tui`; those hooks are stripped by
 * `wrapToolDefinition` before an `AgentTool` is returned. pi-tui is
 * loaded transitively at module-resolve time but never invoked at
 * runtime — Inkstone renders via OpenTUI in `src/tui/**`.
 */
export const readTool = createReadTool(VAULT_DIR);
export const writeTool = createWriteTool(VAULT_DIR);
export const editTool = createEditTool(VAULT_DIR);

/**
 * Baseline permission rules registered at module load. Every agent that
 * composes one of these tools through `composeTools` inherits the
 * baseline; agents can layer additional rules via `AgentInfo.getPermissions`
 * (see reader).
 *
 * Reads are bounded to the vault. Writes and edits add a `confirmDirs`
 * rule so the user is prompted before the agent modifies notes or
 * scraps — the same guardrail the pre-dispatcher guard enforced.
 */
registerBaseline(readTool.name, [{ kind: "insideDirs", dirs: [VAULT_DIR] }]);
registerBaseline(writeTool.name, [
	{ kind: "insideDirs", dirs: [VAULT_DIR] },
	{ kind: "confirmDirs", dirs: [NOTES_DIR, SCRAPS_DIR] },
]);
registerBaseline(editTool.name, [
	{ kind: "insideDirs", dirs: [VAULT_DIR] },
	{ kind: "confirmDirs", dirs: [NOTES_DIR, SCRAPS_DIR] },
]);
