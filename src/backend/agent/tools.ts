import {
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "typebox";
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

// ---------------------------------------------------------------------------
// update_sidebar — generic sidebar section management tool
// ---------------------------------------------------------------------------

const updateSidebarSchema = Type.Object({
	operation: Type.Union([Type.Literal("upsert"), Type.Literal("delete")]),
	id: Type.String({ description: "Unique section identifier (e.g. 'first-pass-prompts')" }),
	title: Type.Optional(Type.String({ description: "Section heading (required for upsert)" })),
	content: Type.Optional(Type.String({ description: "Markdown content (required for upsert)" })),
});

export type UpdateSidebarInput = Static<typeof updateSidebarSchema>;

/**
 * Details payload carried on `tool_execution_end` so the TUI reducer
 * can update the Solid store without re-parsing text content.
 */
export interface UpdateSidebarDetails {
	operation: "upsert" | "delete";
	id: string;
	title?: string;
	content?: string;
}

/**
 * Agent tool that lets any agent upsert or delete sidebar sections.
 * The TUI's `onAgentEvent` reducer picks up the structured `details`
 * from `tool_execution_end` and mutates `store.sidebarSections`.
 *
 * No filesystem access — no permission baseline needed.
 */
export const updateSidebarTool: AgentTool<typeof updateSidebarSchema, UpdateSidebarDetails> = {
	name: "update_sidebar",
	label: "Update Sidebar",
	description:
		"Add, update, or remove a section in the user's sidebar panel. " +
		"Use 'upsert' to create or replace a section (requires title and content). " +
		"Use 'delete' to remove a section by id.",
	parameters: updateSidebarSchema,
	async execute(
		_toolCallId: string,
		params: UpdateSidebarInput,
	): Promise<AgentToolResult<UpdateSidebarDetails>> {
		const { operation, id, title, content } = params;
		if (operation === "upsert") {
			if (!title || !content) {
				throw new Error("upsert requires both 'title' and 'content'");
			}
		}
		const details: UpdateSidebarDetails = { operation, id, title, content };
		const summary =
			operation === "upsert"
				? `Sidebar section '${id}' updated.`
				: `Sidebar section '${id}' removed.`;
		return {
			content: [{ type: "text", text: summary }],
			details,
		};
	},
};
