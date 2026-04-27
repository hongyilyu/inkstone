import {
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { VAULT_DIR } from "./constants";
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
 *               `frontmatterOnlyInDirs` rule fires (see `./permissions.ts`).
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
 * baseline; agents layer additional policy via `AgentInfo.zones`
 * (directory-level write confirmation) or `AgentInfo.getPermissions`
 * (rules zones can't express, e.g. reader's frontmatter-only edit).
 *
 * Baselines are the *hard* vault boundary — writes outside `VAULT_DIR`
 * are blocked regardless of agent declarations. Directory-level
 * confirmation used to live here (`confirmDirs: [NOTES_DIR, SCRAPS_DIR]`
 * on `write`/`edit`) but moved to zones in the D12 refactor: having
 * both a baseline `confirmDirs` and a zones-derived `confirmDirs`
 * covering overlapping dirs produced double-prompts. Zones now own
 * confirmation because they're per-agent (the example agent has no
 * zones and accepts no confirmation; reader declares its three zones
 * and gets confirmation on each).
 */
registerBaseline(readTool.name, [{ kind: "insideDirs", dirs: [VAULT_DIR] }]);
registerBaseline(writeTool.name, [{ kind: "insideDirs", dirs: [VAULT_DIR] }]);
registerBaseline(editTool.name, [{ kind: "insideDirs", dirs: [VAULT_DIR] }]);
