import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	type RenderOptions,
	type RenderResult,
	render,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

export function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
		},
	});
}

export function renderWithQuery(
	ui: ReactElement,
	options?: Omit<RenderOptions, "wrapper">,
): RenderResult {
	const client = makeQueryClient();
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(ui, { wrapper: Wrapper, ...options });
}
