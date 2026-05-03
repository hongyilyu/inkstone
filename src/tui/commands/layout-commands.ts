/**
 * Layout-level command registration. Extracted from `app.tsx` so the
 * top-level `Layout` reads as composition, not a 170-line palette
 * builder.
 *
 * The registration callback is reactive — it's a `createMemo` inside
 * `CommandProvider.register`, so returning `[]` when a command
 * shouldn't apply removes it from the palette AND from keybind
 * dispatch atomically.
 *
 * Note on the `Session`-panel entry: it's keybind-only (`session_list`,
 * Ctrl+N) and hidden from the palette — a palette click can't
 * meaningfully "toggle" a panel. The hook takes the panel state via
 * params so the registration can read/write it through the caller's
 * signal.
 */

import { listAgents } from "@backend/agent";
import { useTerminalDimensions } from "@opentui/solid";
import type { Accessor, Setter } from "solid-js";
import { DialogAgent } from "../components/dialog/agent";
import { type CommandOption, useCommand } from "../components/dialog/command";
import { DialogMiniModel } from "../components/dialog/mini-model";
import { DialogModel } from "../components/dialog/model";
import { DialogProvider as DialogProviderSelect } from "../components/dialog/provider";
import { DialogTheme } from "../components/dialog/theme";
import { DialogVariant } from "../components/dialog/variant";
import { useAgent } from "../context/agent";
import { getSecondaryPage } from "../context/secondary-page";
import { useTheme } from "../context/theme";
import { useToast } from "../ui/toast";

export interface RegisterLayoutCommandsParams {
	sessionListOpen: Accessor<boolean>;
	setSessionListOpen: Setter<boolean>;
	closeSessionList: () => void;
}

/**
 * Register every palette entry + keybind dispatch the Layout owns:
 * Agents (gated on empty session), Models, Effort (gated on
 * reasoning-capable model), Themes, Connect, Clear session, session
 * list toggle, and Tab / Shift+Tab agent cycling.
 */
export function registerLayoutCommands(
	params: RegisterLayoutCommandsParams,
): void {
	const command = useCommand();
	const toast = useToast();
	const { actions, store, session } = useAgent();
	const { themeId } = useTheme();
	const dimensions = useTerminalDimensions();

	command.register(() => {
		const canSwitchAgent = store.messages.length === 0;
		const list: CommandOption[] = [];

		if (canSwitchAgent) {
			list.push({
				id: "agents",
				title: "Agents",
				description: "Switch agent",
				onSelect: (d) => {
					DialogAgent.show(d);
				},
			});
		}

		list.push({
			id: "models",
			title: "Models",
			description: "Switch model",
			onSelect: (d) => {
				DialogModel.show(
					d,
					{
						providerId: session.getProviderId(),
						modelId: session.getModelId(),
					},
					(model) => {
						actions.setModel(model);
					},
				);
			},
		});

		// "Mini Model" palette entry + `/mini-model` slash verb —
		// picks the small/cheap model used for background session
		// title generation (and potentially other non-interactive
		// work later). Writes through to `config.sessionTitleModel`;
		// `resolveTitleModel` reads that override before the active
		// provider's built-in `titleModelId`. Sits next to Models
		// because both are model-selection prefs; kept separate so
		// the interactive chat model and the background mini model
		// are explicitly independent decisions.
		list.push({
			id: "mini-model",
			title: "Mini Model",
			description: "Small model for background title generation",
			slash: { name: "mini-model", takesArgs: false },
			onSelect: (d) => {
				DialogMiniModel.show(d, session.getProviderId(), session.getModelId());
			},
		});

		// "Effort" palette entry — standalone switcher for the current
		// model's reasoning level. Only registered when the active model
		// supports reasoning; a non-reasoning model has nothing to pick
		// (the only available level is "off"), so the entry is hidden to
		// avoid palette noise. Mirrors OpenCode's `hidden` flag on the
		// `variant.list` command
		// (`opencode/src/cli/cmd/tui/app.tsx:537`), which is driven by
		// `local.model.variant.list().length === 0`. The
		// `store.modelReasoning` read makes this registration reactive,
		// so switching to/from a reasoning model shows/hides the entry
		// immediately.
		if (store.modelReasoning) {
			list.push({
				id: "effort",
				title: "Effort",
				description: "Reasoning effort",
				onSelect: (d) => {
					DialogVariant.show(
						d,
						session.getModel(),
						session.getThinkingLevel(),
						(level) => {
							actions.setThinkingLevel(level);
						},
					);
				},
			});
		}

		list.push(
			{
				id: "themes",
				title: "Themes",
				description: "Switch theme",
				onSelect: (d) => {
					DialogTheme.show(d, themeId());
				},
			},
			{
				id: "connect",
				title: "Connect",
				description: "Manage providers",
				onSelect: (d) => {
					DialogProviderSelect.show(
						d,
						(model) => {
							actions.setModel(model);
						},
						session.getProviderId(),
					);
				},
			},
			// Shell-level slash verb. Registered here (not on an agent)
			// so every agent inherits it without declaring a `clear`
			// command. Slash dispatch in `prompt.tsx` matches against
			// the unified registry — see SLASH-COMMANDS.md Path A.
			{
				id: "session.clear",
				title: "Clear session",
				description: "Clear the current session",
				slash: { name: "clear" },
				onSelect: () => {
					// Fire-and-forget: `clearSession` is async to await a
					// mid-stream `agent.abort()`, but callers in command
					// palette/slash dispatch don't await. The Promise
					// can't reject (pi-agent-core's `reset()` is
					// synchronous and `waitForIdle()` never throws), so
					// dropping it is safe.
					void actions.clearSession();
				},
			},
			// Keybind-only: Ctrl+N toggles the left session panel.
			// Hidden from the palette (a palette click can't
			// meaningfully "toggle" a panel — it'd just open it, which
			// is misleading).
			{
				id: "session_list",
				title: "Sessions",
				keybind: "session_list",
				hidden: true,
				onSelect: () => {
					if (getSecondaryPage()) return; // no session list while secondary page is open
					if (params.sessionListOpen()) {
						params.closeSessionList();
						return;
					}
					if (dimensions().width < 80) {
						toast.show({
							variant: "warning",
							title: "Terminal too narrow",
							message: "Widen the window to open the session panel.",
							duration: 3000,
						});
						return;
					}
					params.setSessionListOpen(true);
				},
			},
		);

		// Tab / Shift+Tab cycle agents on the open page only. Hidden
		// from the palette (they're keybind-only) and disabled once
		// messages exist.
		if (canSwitchAgent) {
			const cycle = (dir: 1 | -1) => {
				const all = listAgents();
				if (all.length <= 1) return;
				const i = all.findIndex((a) => a.name === store.currentAgent);
				const base = i < 0 ? 0 : i;
				const next = all[(base + dir + all.length) % all.length];
				if (next) actions.selectAgent(next.name);
			};
			list.push(
				{
					id: "agent_cycle",
					title: "Next agent",
					keybind: "agent_cycle",
					hidden: true,
					onSelect: () => cycle(1),
				},
				{
					id: "agent_cycle_reverse",
					title: "Previous agent",
					keybind: "agent_cycle_reverse",
					hidden: true,
					onSelect: () => cycle(-1),
				},
			);
		}

		return list;
	});
}
