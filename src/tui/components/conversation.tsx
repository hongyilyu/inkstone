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
	const { theme, syntax, subtleSyntax } = useTheme();
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
					{(msg, index) => {
						// A user bubble is "dangling" when no assistant reply
						// follows it AND we're not currently streaming a reply
						// for it. Covers the resumed-orphan case (session was
						// killed mid-turn, so `agent_messages` + `messages`
						// both stored the user with no assistant) — we render
						// a muted "[Interrupted by user]" marker beneath so
						// the history reads correctly.
						//
						// The `isTail && isStreaming` skip is because
						// `message_start` hasn't pushed the assistant bubble
						// onto `store.messages` yet during that window; the
						// tail user during an in-flight reply is not
						// dangling.
						const isDanglingUser = createMemo(() => {
							if (msg.role !== "user") return false;
							const next = store.messages[index() + 1];
							if (next && next.role === "assistant") return false;
							const isTail = index() === store.messages.length - 1;
							if (isTail && store.isStreaming) return false;
							return true;
						});
						return (
							<Show when={msg.parts.length > 0 || msg.error}>
								<Show
									when={msg.role === "user"}
									fallback={
										<box flexDirection="column" flexShrink={0}>
											<For each={msg.parts}>
												{(part, partIndex) => {
													// `streaming` must only flag the absolute tail block
													// of the in-flight turn; markdown's partial-token
													// parser keeps that block unstable and finalizes
													// earlier ones.
													const isTail = () =>
														store.isStreaming &&
														index() === store.messages.length - 1 &&
														partIndex() === msg.parts.length - 1;
													if (part.type === "thinking") {
														// Mirrors OpenCode's `ReasoningPart`
														// (`routes/session/index.tsx:1437-1468`): single
														// markdown block with an inline `_Thinking:_`
														// italic prefix, rendered through `subtleSyntax`
														// so every token is alpha-faded uniformly while
														// preserving per-scope hue. No outer `fg` — that
														// would flatten all tokens to one color and cancel
														// the per-scope dimming.
														return (
															<box
																paddingLeft={2}
																marginTop={partIndex() === 0 ? 0 : 1}
																border={["left"]}
																borderColor={theme.backgroundElement}
																customBorderChars={SplitBorderChars}
																flexShrink={0}
																flexDirection="column"
															>
																<markdown
																	content={`_Thinking:_ ${part.text}`}
																	syntaxStyle={subtleSyntax()}
																	streaming={isTail()}
																	bg={theme.background}
																/>
															</box>
														);
													}
													return (
														<box
															paddingLeft={3}
															marginTop={partIndex() === 0 ? 0 : 1}
															flexShrink={0}
														>
															<markdown
																content={part.text}
																syntaxStyle={syntax()}
																streaming={isTail()}
																fg={theme.text}
																bg={theme.background}
															/>
														</box>
													);
												}}
											</For>
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
													marginTop={msg.parts.length > 0 ? 1 : 0}
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
									<box flexDirection="column" flexShrink={0}>
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
												<text fg={theme.text}>{msg.parts[0]?.text ?? ""}</text>
											</box>
										</box>
										{/* Dangling-user marker: the stored stream was
                                        killed mid-turn so no assistant reply
                                        followed. Mirrors the load-time repair
                                        in `loadSession` — the user's typed text
                                        stays in scrollback; the marker tells
                                        them why there's no response beneath. */}
										<Show when={isDanglingUser()}>
											<box paddingLeft={3} paddingTop={1} flexShrink={0}>
												<text fg={theme.textMuted}>[Interrupted by user]</text>
											</box>
										</Show>
									</box>
								</Show>
							</Show>
						);
					}}
				</For>
			</box>
		</scrollbox>
	);
}
