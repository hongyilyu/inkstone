import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { AlertTriangle, Compass } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EmptyState } from "./components/ui/empty-state.tsx";
import { routeTree } from "./routeTree.gen";
import { RuntimeProvider } from "./runtime.tsx";
import "./index.css";

// Mock data never goes stale: prevent refetch loops.
const queryClient = new QueryClient({
	defaultOptions: {
		queries: { staleTime: Number.POSITIVE_INFINITY },
	},
});

/** Last-resort error UI for an uncaught render crash. Without this the user falls
 * to TanStack Router's bare unstyled fallback (no Inkstone chrome, raw error). A
 * styled, calm recovery affordance keeps a crash inside the product. */
function RootErrorState({ reset }: { reset: () => void }) {
	return (
		<div className="flex h-dvh items-center justify-center bg-background p-8">
			<EmptyState
				icon={AlertTriangle}
				tone="danger"
				size="lg"
				title="Something went wrong"
				description="Inkstone hit an unexpected error rendering this view. Reloading usually clears it."
				action={
					<button
						type="button"
						onClick={() => {
							reset();
							window.location.reload();
						}}
						className="inline-flex h-9 cursor-pointer items-center rounded-lg bg-primary px-4 font-semibold text-primary-foreground text-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
					>
						Reload Inkstone
					</button>
				}
			/>
		</div>
	);
}

/** Styled fallback for a URL that matches no route (vs the bare router default). */
function RootNotFoundState() {
	return (
		<div className="flex h-dvh items-center justify-center bg-background p-8">
			<EmptyState
				icon={Compass}
				size="lg"
				title="Page not found"
				description="That address doesn't lead anywhere in Inkstone."
				action={
					<a
						href="/"
						className="inline-flex h-9 items-center rounded-lg bg-secondary px-4 font-semibold text-secondary-foreground text-sm transition-colors hover:bg-primary/10 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
					>
						Back to chat
					</a>
				}
			/>
		</div>
	);
}

// File-based router (ADR-0024); providers stay ABOVE it so route components read QueryClient + Runtime via context.
const router = createRouter({
	routeTree,
	defaultErrorComponent: RootErrorState,
	defaultNotFoundComponent: RootNotFoundState,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

const root = document.getElementById("root");

if (!root) {
	throw new Error("Root element #root not found");
}

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RuntimeProvider>
				<RouterProvider router={router} />
			</RuntimeProvider>
		</QueryClientProvider>
	</StrictMode>,
);
