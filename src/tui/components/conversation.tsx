import type { ScrollBoxRenderable } from "@opentui/core";
import { For, Show } from "solid-js";
import { refocusInput, setScrollRef } from "../app";
import { useAgent } from "../context/agent";
import { AssistantMessage, UserMessage } from "./message";

/**
 * Scrollable conversation view. Thin list + routing layer — bubble
 * rendering (and per-bubble concerns like the interrupted-user marker)
 * live in `message.tsx`.
 */
export function Conversation() {
	const { store } = useAgent();

	return (
		<scrollbox
			ref={(r: ScrollBoxRenderable) => setScrollRef(r)}
			stickyScroll={true}
			stickyStart="bottom"
			flexGrow={1}
			onMouseUp={() => {
				setTimeout(() => refocusInput(), 1);
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
