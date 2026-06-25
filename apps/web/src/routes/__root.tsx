import { useQueryClient } from "@tanstack/react-query";
import {
	createRootRoute,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { EntityCue } from "@/components/EntityCue";
import { useRuntime } from "@/runtime";
import {
	registerThreadTitledHandler,
	setOnRunSettled,
	startConnectionStream,
} from "@/store/bridge";
import { noteNonSettingsLocation } from "@/store/settings-origin";

/** Root route (ADR-0024): renders the active `<Outlet/>` plus the global command palette (⌘K), reachable from every surface. */
function RootLayout() {
	// Track the last non-settings location so Esc in the settings takeover returns there, not to a prior tab (`store/settings-origin`).
	const href = useRouterState({ select: (s) => s.location.href });
	useEffect(() => {
		noteNonSettingsLocation(href);
	}, [href]);

	// Refresh the recent-Runs feed whenever ANY Run settles (foreground or
	// background) — wired once here, at the global mount, to the bridge's terminal
	// seam so off-screen completions still update the feed (ADR-0028 read side).
	const queryClient = useQueryClient();
	useEffect(() => {
		setOnRunSettled(() => {
			void queryClient.invalidateQueries({ queryKey: ["run-history"] });
		});
		return () => setOnRunSettled(undefined);
	}, [queryClient]);

	// Patch the ["threads"] cache in place when Core pushes thread/titled, so the
	// sidebar row re-titles live without a refetch (ADR-0047). The disposer clears
	// the handler on unmount.
	useEffect(() => registerThreadTitledHandler(queryClient), [queryClient]);

	// Start the socket-liveness fiber ONCE here at the global mount (ADR-0051), so
	// the NavShell connection indicator is live on EVERY shell (chat + Library) —
	// unlike the chat-scoped proposal stream, which would leave the Library
	// indicator dead. `startConnectionStream` is idempotent.
	const runtime = useRuntime();
	useEffect(() => {
		startConnectionStream(runtime);
	}, [runtime]);

	return (
		<>
			<Outlet />
			<CommandPalette />
			<EntityCue />
		</>
	);
}

export const Route = createRootRoute({
	component: RootLayout,
});
