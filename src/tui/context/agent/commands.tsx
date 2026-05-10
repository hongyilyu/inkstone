/**
 * Bridge backend-declared `AgentCommand`s into the shared command
 * registry + the `AgentCommandHelpers` bag the backend hands to every
 * `AgentCommand.execute` call.
 *
 * Lives as a closure component so it has an owner for `onCleanup` and
 * can capture `wrappedActions` without widening the context value.
 * Mounts inside `<agentContext.Provider>` (which is nested inside
 * `CommandProvider` at the app root).
 */

import { DEFAULT_AGENT_NAME, getAgentInfo, listAgents } from "@backend/agent";
import type { AgentCommandHelpers, AgentInfo } from "@backend/agent/types";
import type { AgentStoreState, DisplayPart } from "@bridge/view-model";
import type { SetStoreFunction } from "solid-js/store";
import {
	type AgentSlashOption,
	useCommand,
} from "../../components/dialog/command";
import type { LayoutContextValue } from "../../context/layout";
import type { DialogContext } from "../../ui/dialog";
import { DialogSelect } from "../../ui/dialog-select";
import type { useToast } from "../../ui/toast";
import type { MessageLog } from "./message-log";
import type { SessionState } from "./session-state";
import type { AgentContextValue } from "./types";

export interface CommandsDeps {
	actions: AgentContextValue["actions"];
	store: AgentStoreState;
	setStore: SetStoreFunction<AgentStoreState>;
	sessionState: SessionState;
	layout: LayoutContextValue;
	dialog: DialogContext;
	toast: ReturnType<typeof useToast>;
	/** See `ReducerDeps.messageLog`. */
	messageLog: MessageLog;
}

/**
 * Build the `AgentCommandHelpers` bag injected into every
 * `AgentCommand.execute` call. Closes over `wrappedActions`, `dialog`,
 * and the store so commands can push display bubbles and open picker
 * dialogs without knowing about the TUI layer.
 */
function buildCommandHelpers(deps: CommandsDeps): AgentCommandHelpers {
	return {
		// Forward the optional `displayParts` so commands like reader's
		// `/article` can render a compact bubble while pi-agent-core
		// still receives the full-content `text`. See
		// `wrappedActions.prompt` for the split; pi-agent-core is blind
		// to `displayParts` by construction — it lives entirely in the
		// Solid store.
		prompt: (text: string, displayParts?: DisplayPart[]) =>
			deps.actions.prompt(text, displayParts),
		displayMessage(text: string) {
			// Best-effort: pushes a command-authored user line as a
			// bubble (e.g. reader's `/article` recommendation list).
			// Disk-write failure is logged-and-swallowed — the bubble
			// still shows in-memory; resume would miss it. Matches the
			// pre-MessageLog behavior.
			deps.sessionState.ensureSession();
			deps.messageLog.appendBubbleBestEffort([{ type: "text", text }]);
			deps.layout.scrollToBottom();
		},
		pickFromList({ title, size, options }) {
			let settled = false;
			return new Promise<string | undefined>((resolve) => {
				deps.dialog.replace(
					() => (
						<DialogSelect<string>
							title={title}
							placeholder="Search..."
							options={options.map((o) => ({
								title: o.title,
								value: o.value,
								description: o.description,
							}))}
							onSelect={(opt) => {
								if (settled) return;
								settled = true;
								resolve(opt.value);
							}}
						/>
					),
					// `onClose` fires when ESC dismisses the dialog
					// without a selection — resolve `undefined` so the
					// command can exit cleanly without starting a turn.
					// Also fires after `dialog.clear()` on the select
					// path (double-resolve); the `settled` flag ensures
					// only the first resolve takes effect.
					() => {
						if (settled) return;
						settled = true;
						resolve(undefined);
					},
				);
				// `dialog.replace` resets size to "medium"; set the
				// requested size after so it takes effect.
				if (size) deps.dialog.setSize(size);
			});
		},
	};
}

/**
 * Bridge backend-declared `AgentCommand`s into the agent-slash
 * channel of the unified command registry.
 *
 * Per ADR 0006 the Ctrl+P palette is program-config-scoped (model,
 * effort, themes, …) — agent verbs live in the slash dropdown only.
 * The registry exposes a separate `registerAgentSlash` channel that
 * feeds the dropdown but never the palette; this bridge writes to
 * that channel so we don't need a per-entry "hide from palette" flag.
 *
 * Reactive on `store.currentAgent` AND `store.messages.length`: the
 * registration callback re-runs when the user switches agents or
 * commits the session via the first turn.
 *
 * Verb-set rules:
 *   - Open page bound to the default router with no messages →
 *     **fan out**: register every non-router agent's verbs (per ADR
 *     0006 the open-page autocomplete shows every agent's verbs
 *     before commitment, so the user can invoke any verb without
 *     pre-picking the agent).
 *   - Otherwise → register only the bound agent's verbs.
 */
export function BridgeAgentCommands(props: { deps: CommandsDeps }) {
	const command = useCommand();
	command.registerAgentSlash((): AgentSlashOption[] => {
		const fanOut =
			props.deps.store.messages.length === 0 &&
			props.deps.store.currentAgent === DEFAULT_AGENT_NAME;
		const targets: AgentInfo[] = fanOut
			? listAgents().filter((a) => a.name !== DEFAULT_AGENT_NAME)
			: [getAgentInfo(props.deps.store.currentAgent)];
		return targets.flatMap((info) => {
			if (!info.commands || info.commands.length === 0) return [];
			return info.commands.map((c) => ({
				id: `agent.${info.name}.${c.name}`,
				title: `/${c.name}${c.argHint ? ` ${c.argHint}` : ""}`,
				description: c.description,
				slash: {
					name: c.name,
					takesArgs: c.takesArgs,
					argHint: c.argHint,
					argGuide: c.argGuide,
					canExecute: c.canExecute,
				},
				onSelect: (_d, args) => {
					// Fire-and-forget. Errors thrown before `prompt(...)` runs
					// (e.g. reader's `/article missing.md` throws during file
					// validation, before any agent turn starts) bypass the
					// prompt wrapper's catch — so we handle rejections here
					// directly and surface a toast. Errors raised *during* a
					// streaming turn still flow through
					// `wrappedActions.prompt` and land on the in-flight
					// bubble as usual. `execute` may return `void` (sync
					// commands); wrap in Promise.resolve so `.catch` is
					// always available.
					const helpers = buildCommandHelpers(props.deps);
					Promise.resolve(c.execute(args ?? "", helpers)).catch(
						(err: unknown) => {
							const msg = err instanceof Error ? err.message : String(err);
							props.deps.toast.show({
								variant: "error",
								title: "Command error",
								message: msg,
								duration: 6000,
							});
						},
					);
				},
			}));
		});
	});
	return null;
}
