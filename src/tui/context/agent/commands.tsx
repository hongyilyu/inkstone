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

import { getAgentInfo } from "@backend/agent";
import type { AgentCommandHelpers } from "@backend/agent/types";
import {
	appendDisplayMessage,
	newId,
	runInTransaction,
	safeRun,
} from "@backend/persistence/sessions";
import type {
	AgentStoreState,
	DisplayMessage,
	DisplayPart,
} from "@bridge/view-model";
import { produce, type SetStoreFunction } from "solid-js/store";
import { toBottom } from "../../app";
import {
	type CommandOption,
	useCommand,
} from "../../components/dialog/command";
import type { DialogContext } from "../../ui/dialog";
import { DialogSelect } from "../../ui/dialog-select";
import type { useToast } from "../../ui/toast";
import type { SessionState } from "./session-state";
import type { AgentContextValue } from "./types";

export interface CommandsDeps {
	actions: AgentContextValue["actions"];
	store: AgentStoreState;
	setStore: SetStoreFunction<AgentStoreState>;
	sessionState: SessionState;
	dialog: DialogContext;
	toast: ReturnType<typeof useToast>;
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
			const sessionId = deps.sessionState.ensureSession();
			const userMsg: DisplayMessage = {
				id: newId(),
				role: "user",
				parts: [{ type: "text", text }],
			};
			deps.setStore(
				"messages",
				produce((msgs: DisplayMessage[]) => {
					msgs.push(userMsg);
				}),
			);
			// safeRun: `displayMessage` is a command helper that pushes
			// a user-authored line into the conversation as a bubble
			// (e.g. reader's `/article` recommendation list). Failure
			// is benign at runtime — the bubble still shows in-memory;
			// resume would miss it. Matches the pre-fix behavior.
			safeRun(() =>
				runInTransaction((tx) => appendDisplayMessage(tx, sessionId, userMsg)),
			);
			toBottom();
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
 * Bridge backend-declared `AgentCommand`s into the unified command
 * registry.
 *
 * Reactive on `store.currentAgent`: the registration callback re-runs
 * when the user switches agents, so an agent's slash verbs only
 * match while that agent is active.
 *
 * Argful commands (`takesArgs`) register with `hidden: true` so they
 * don't appear in the Ctrl+P palette — palette-click can't supply
 * arguments, so showing them would be misleading. They're still
 * slash-dispatched through the prompt.
 *
 * Agent-bridge registrations sit ahead of shell registrations in the
 * registry's `entries` list (AgentProvider mounts inside
 * CommandProvider, and `register` prepends to the list), so on slash-
 * name collision the agent-scoped entry wins — preserves D9's
 * "agent overrides built-in" rule.
 */
export function BridgeAgentCommands(props: { deps: CommandsDeps }) {
	const command = useCommand();
	command.register((): CommandOption[] => {
		const info = getAgentInfo(props.deps.store.currentAgent);
		if (!info.commands || info.commands.length === 0) return [];
		return info.commands.map((c) => ({
			id: `agent.${info.name}.${c.name}`,
			title: `/${c.name}${c.argHint ? ` ${c.argHint}` : ""}`,
			description: c.description,
			hidden: !!c.takesArgs,
			slash: {
				name: c.name,
				takesArgs: c.takesArgs,
				argHint: c.argHint,
				argGuide: c.argGuide,
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
	return null;
}
