import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { RuntimeProvider } from "./runtime.tsx";
import "./index.css";

// Mock data never goes stale: prevent refetch loops.
const queryClient = new QueryClient({
	defaultOptions: {
		queries: { staleTime: Number.POSITIVE_INFINITY },
	},
});

const root = document.getElementById("root");

if (!root) {
	throw new Error("Root element #root not found");
}

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RuntimeProvider>
				<App />
			</RuntimeProvider>
		</QueryClientProvider>
	</StrictMode>,
);
