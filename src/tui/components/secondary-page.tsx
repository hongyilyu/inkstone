/**
 * Full-screen secondary page. Replaces the conversation area when
 * a secondary page is open. Renders content in a scrollable main area.
 *
 * Generic: content + format are provided by the caller via
 * `openSecondaryPage()`. Markdown is the default (reader's `/article`
 * and `@`-mention previews); `"text"` renders raw text for non-markdown
 * content like subagent output or logs.
 *
 * Navigation: ESC/Ctrl+[ or the sidebar back button calls
 * `closeSecondaryPage()`.
 */

import { Show } from "solid-js";
import { getSecondaryPage } from "../context/secondary-page";
import { useTheme } from "../context/theme";

export function SecondaryPage() {
	const { theme, syntax } = useTheme();

	const state = () => getSecondaryPage();
	const content = () => state()?.content ?? "";
	const format = () => state()?.format ?? "markdown";

	return (
		<scrollbox
			flexGrow={1}
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
			paddingBottom={1}
		>
			<Show
				when={format() === "text"}
				fallback={
					<markdown
						content={content()}
						syntaxStyle={syntax()}
						fg={theme.text}
						bg={theme.background}
					/>
				}
			>
				<text fg={theme.text} bg={theme.background} wrapMode="word">
					{content()}
				</text>
			</Show>
		</scrollbox>
	);
}
