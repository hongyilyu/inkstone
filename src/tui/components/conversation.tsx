import { getAgentInfo } from "@backend/agent";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createMemo, For, Show } from "solid-js";
import { refocusInput, setScrollRef } from "../app";
import { useAgent } from "../context/agent";
import { useTheme } from "../context/theme";
import { formatDuration } from "../util/format";

const EmptyBorder = {
	topLeft: "",
	bottomLeft: "",
	vertical: "",
	topRight: "",
	bottomRight: "",
	horizontal: " ",
	bottomT: "",
	topT: "",
	cross: "",
	leftT: "",
	rightT: "",
};

const SplitBorderChars = {
	...EmptyBorder,
	vertical: "┃",
};

export function Conversation() {
	const { theme, syntax } = useTheme();
	const { store } = useAgent();

	// Accent color for user-message borders and the assistant-footer `▣` glyph,
	// derived from the currently-active agent. Agent switching is locked to an
	// empty session, so a single accent applies uniformly to every bubble in
	// the current transcript.
	const agentColor = createMemo(
		() => theme[getAgentInfo(store.currentAgent).colorKey],
	);

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
						<Show when={msg.text || msg.error}>
							<Show
								when={msg.role === "user"}
								fallback={
									<box flexDirection="column" flexShrink={0}>
										<Show when={msg.text}>
											<box paddingLeft={3} flexShrink={0}>
												<markdown
													content={msg.text}
													syntaxStyle={syntax()}
													streaming={
														store.isStreaming &&
														index() === store.messages.length - 1
													}
													fg={theme.text}
													bg={theme.background}
												/>
											</box>
										</Show>
										{/* Assistant-turn error panel. Mirrors OpenCode's
                                            per-message error box
                                            (`routes/session/index.tsx:1374-1387`) — left
                                            border in theme.error, muted body text.
                                            `marginLeft={3}` aligns the left edge with the
                                            markdown body above. Covers both
                                            `stopReason === "error"` and `"aborted"` for
                                            now; distinct "interrupted" footer styling is
                                            tracked as future work. */}
										<Show when={msg.error}>
											<box
												marginLeft={3}
												marginTop={msg.text ? 1 : 0}
												border={["left"]}
												borderColor={theme.error}
												customBorderChars={SplitBorderChars}
											>
												<box
													paddingTop={1}
													paddingBottom={1}
													paddingLeft={2}
													backgroundColor={theme.backgroundPanel}
													flexShrink={0}
												>
													<text fg={theme.textMuted}>{msg.error}</text>
												</box>
											</box>
										</Show>
										<Show when={msg.modelName}>
											<box paddingLeft={3} paddingTop={1} flexShrink={0}>
												<text wrapMode="none">
													<span style={{ fg: agentColor() }}>{"▣ "}</span>
													<span style={{ fg: theme.text }}>
														{msg.agentName ?? "Reader"}
													</span>
													<span style={{ fg: theme.textMuted }}>
														{" "}
														· {msg.modelName}
														{msg.duration && msg.duration > 0
															? ` · ${formatDuration(msg.duration)}`
															: ""}
													</span>
												</text>
											</box>
										</Show>
									</box>
								}
							>
								<box
									border={["left"]}
									borderColor={agentColor()}
									customBorderChars={SplitBorderChars}
									marginTop={index() === 0 ? 0 : 1}
								>
									<box
										paddingTop={1}
										paddingBottom={1}
										paddingLeft={2}
										backgroundColor={theme.backgroundPanel}
										flexShrink={0}
									>
										<text fg={theme.text}>{msg.text}</text>
									</box>
								</box>
							</Show>
						</Show>
					)}
				</For>
			</box>
		</scrollbox>
	);
}
