import {
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { VAULT_DIR } from "./constants";
import { registerBaseline } from "./permissions";

/**
 * Shared tool pool. Agents pick entries via `extraTools`; `compose.ts`
 * pulls `readTool` into `BASE_TOOLS`. Factories come from pi-coding-agent
 * and receive `VAULT_DIR` as `cwd` for relative-path resolution. See
 * `docs/ARCHITECTURE.md` § Permission Dispatcher for the full composition
 * and sandbox model.
 *
 * pi-coding-agent's tool factories embed `renderCall` / `renderResult`
 * hooks that reference `@mariozechner/pi-tui`. Those hooks are stripped
 * by `wrapToolDefinition`, so pi-tui is loaded transitively at module-
 * resolve but never invoked at runtime — Inkstone renders via OpenTUI
 * in `src/tui/**`.
 */
export const readTool = createReadTool(VAULT_DIR);
export const writeTool = createWriteTool(VAULT_DIR);
export const editTool = createEditTool(VAULT_DIR);

/**
 * Baseline permission rules registered at module load — the hard vault
 * boundary. Agents layer additional policy via `zones` and
 * `getPermissions`. See `docs/ARCHITECTURE.md` § Tool baselines.
 */
registerBaseline(readTool.name, [{ kind: "insideDirs", dirs: [VAULT_DIR] }]);
registerBaseline(writeTool.name, [{ kind: "insideDirs", dirs: [VAULT_DIR] }]);
registerBaseline(editTool.name, [{ kind: "insideDirs", dirs: [VAULT_DIR] }]);
