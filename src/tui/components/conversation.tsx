import type { DisplayMessage } from "@bridge/view-model";
import type { ScrollBoxRenderable } from "@opentui/core";
import { For, Show } from "solid-js";
import { refocusInput, setScrollRef } from "../app";
import { useAgent } from "../context/agent";
import { AssistantMessage, UserMessage } from "./message";

/**
 * Scrollable conversation view. Owns only list layout and per-row
 * routing — bubble rendering lives in `message.tsx`.
 *
 * Dangling-user detection: a user bubble is "dangling" when it has no
 * real assistant reply following it AND no stream is pending. A real
 * reply is one with at least one part OR an error — the outer `<Show>`
 * gate below uses the same shape, so an orphan empty-parts assistant
 * (a header row inserted on `message_start` but parts never flushed
 * because `message_end` never fired) doesn't mask the marker.
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
						<Show when={msg.parts.length > 0 || msg.error}>
							<Show
								when={msg.role === "user"}
								fallback={
									<AssistantMessage
										message={msg}
										isTailTurn={index() === store.messages.length - 1}
									/>
								}
							>
								<UserMessage
									message={msg}
									first={index() === 0}
									dangling={isDanglingUser(
										msg,
										index(),
										store.messages,
										store.isStreaming,
									)}
								/>
							</Show>
						</Show>
					)}
				</For>
			</box>
		</scrollbox>
	);
}

function isDanglingUser(
	msg: DisplayMessage,
	index: number,
	messages: DisplayMessage[],
	isStreaming: boolean,
): boolean {
	if (msg.role !== "user") return false;
	const next = messages[index + 1];
	if (next && next.role === "assistant") {
		const real = next.parts.length > 0 || !!next.error;
		if (real) return false;
		// Ghost assistant header (parts never flushed) — fall through.
	}
	const isTail = index === messages.length - 1;
	if (isTail && isStreaming) return false;
	return true;
}
