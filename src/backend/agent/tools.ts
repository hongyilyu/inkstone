import {
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { VAULT_DIR } from "./constants";

/**
 * Shared tool pool. Any agent picks from here via `extraTools` (reader
 * uses `[editTool, writeTool]`; example uses `[]`); `base.ts` pulls
 * `readTool` into `BASE_TOOLS` so every agent gets it unconditionally.
 *
 * Implementations come from `@mariozechner/pi-coding-agent`:
 *   - `read`  — file read with offset/limit + image support + truncation.
 *   - `write` — overwrite-only file write; creates parent dirs; mutation-queued.
 *   - `edit`  — multi-edit unified diff; mutation-queued. Params are
 *               `{ path, edits: [{ oldText, newText }, ...] }` — the guard
 *               (`./guard.ts`) iterates `args.edits[]` when checking that
 *               edits to an active article touch only the frontmatter.
 *
 * `VAULT_DIR` is passed as `cwd` so vault-relative paths resolve inside
 * the vault. The factories do NOT sandbox — an absolute `/etc/passwd`
 * path would be honored by the tool itself. Sandbox enforcement remains
 * `beforeToolCall` in `./guard.ts`, which checks `startsWith(VAULT_DIR)`
 * on the resolved path. pi-coding-agent also expands `~` in paths; the
 * guard's `startsWith` still catches anything that lands outside.
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
