import { createFileRoute, useNavigate } from "@tanstack/react-router";
import App from "../App.js";
import { setFocusedThread } from "../store/chat.js";

/**
 * `/` — the chat surface. `App` stays router-free (presentational); this route
 * wires its settings gear to navigate to `/settings/models` (ADR-0024), and a
 * recent-Runs feed row to focus that Run's Thread in place (no route change).
 */
function ChatRoute() {
	const navigate = useNavigate();
	return (
		<App
			onOpenSettings={() => navigate({ to: "/settings/models" })}
			onOpenLibrary={() => navigate({ to: "/library" })}
			onOpenThread={(threadId) => setFocusedThread(threadId)}
		/>
	);
}

export const Route = createFileRoute("/")({
	component: ChatRoute,
});
