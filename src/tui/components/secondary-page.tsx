/**
 * Full-screen secondary page. Replaces the conversation area when
 * a secondary page is open. Renders content in a scrollable main area.
 *
 * Generic: content is provided by the caller via `openSecondaryPage()`.
 * Navigation: ESC/Ctrl+[ or the sidebar back button calls `closeSecondaryPage()`.
 *
 * TODO: Currently renders content as markdown only. Expand to support
 * other formats (plain text, structured data, custom renderers) when
 * needed — e.g. subagent work output, logs, or non-markdown content.
 */

import { getSecondaryPage } from "../context/secondary-page";
import { useTheme } from "../context/theme";

export function SecondaryPage() {
	const { theme, syntax } = useTheme();

	const content = () => getSecondaryPage()?.content ?? "";

	return (
		<scrollbox
			flexGrow={1}
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
			paddingBottom={1}
		>
			<markdown
				content={content()}
				syntaxStyle={syntax()}
				fg={theme.text}
				bg={theme.background}
			/>
		</scrollbox>
	);
}
