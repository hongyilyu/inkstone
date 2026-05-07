import type { ScrollBoxRenderable } from "@opentui/core";
import { For, onCleanup, Show } from "solid-js";
import { useAgent } from "../context/agent";
import { useLayout } from "../context/layout";
import { AssistantMessage, UserMessage } from "./message";

/**
 * Scrollable conversation view. Thin list + routing layer — bubble
 * rendering (and per-bubble concerns like the interrupted-user marker)
 * live in `message.tsx`.
 */
export function Conversation() {
	const { store } = useAgent();
	const layout = useLayout();

	return (
		<scrollbox
			ref={(r: ScrollBoxRenderable) => {
				layout.setScrollRef(r);
				onCleanup(() => layout.clearScrollRef(r));
			}}
			stickyScroll={true}
			stickyStart="bottom"
			flexGrow={1}
			onMouseUp={() => {
				setTimeout(() => layout.focusInput(), 1);
			}}
		>
			<box flexDirection="column" paddingTop={1} paddingRight={1} gap={1}>
				<For each={store.messages}>
					{(msg, index) => (
						<Show when={msg.parts.length > 0 || msg.error || msg.interrupted}>
							<Show
								when={msg.role === "user"}
								fallback={
									<AssistantMessage
										message={msg}
										isTailTurn={index() === store.messages.length - 1}
									/>
								}
							>
								<UserMessage message={msg} first={index() === 0} />
							</Show>
						</Show>
					)}
				</For>
			</box>
		</scrollbox>
	);
}
