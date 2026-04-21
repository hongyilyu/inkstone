import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createContext, type ParentProps, Show, useContext } from "solid-js";
import { createStore } from "solid-js/store";
import { type ThemeColors, useTheme } from "../context/theme";

export interface ToastOptions {
	title?: string;
	message: string;
	variant: keyof Pick<ThemeColors, "error" | "warning" | "success" | "info">;
	duration?: number;
}

export function Toast() {
	const toast = useToast();
	const { theme } = useTheme();
	const dimensions = useTerminalDimensions();

	return (
		<Show when={toast.currentToast}>
			{(current: () => ToastOptions) => (
				<box
					position="absolute"
					justifyContent="center"
					alignItems="flex-start"
					top={2}
					right={2}
					maxWidth={Math.min(60, dimensions().width - 6)}
					paddingLeft={2}
					paddingRight={2}
					paddingTop={1}
					paddingBottom={1}
					backgroundColor={theme.backgroundPanel}
					borderColor={theme[current().variant]}
					border={["left", "right"]}
				>
					<Show when={current().title}>
						<text
							attributes={TextAttributes.BOLD}
							marginBottom={1}
							fg={theme.text}
						>
							{current().title}
						</text>
					</Show>
					<text fg={theme.text} wrapMode="word" width="100%">
						{current().message}
					</text>
				</box>
			)}
		</Show>
	);
}

function init() {
	const [store, setStore] = createStore({
		currentToast: null as ToastOptions | null,
	});

	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

	const toast = {
		show(options: ToastOptions) {
			const { duration = 3000, ...rest } = options;
			setStore("currentToast", rest);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			timeoutHandle = setTimeout(() => {
				setStore("currentToast", null);
			}, duration);
		},
		error(err: unknown) {
			if (err instanceof Error)
				return toast.show({ variant: "error", message: err.message });
			toast.show({
				variant: "error",
				message: "An unknown error has occurred",
			});
		},
		get currentToast(): ToastOptions | null {
			return store.currentToast;
		},
	};
	return toast;
}

export type ToastContext = ReturnType<typeof init>;

const ctx = createContext<ToastContext>();

export function ToastProvider(props: ParentProps) {
	const value = init();
	return <ctx.Provider value={value}>{props.children}</ctx.Provider>;
}

export function useToast() {
	const value = useContext(ctx);
	if (!value) throw new Error("useToast must be used within a ToastProvider");
	return value;
}
