/**
 * Full-screen secondary page. Replaces the conversation area when
 * a secondary page is open. Renders markdown content in a scrollable
 * main area.
 *
 * Generic: content is provided by the caller via `openSecondaryPage()`.
 * Navigation: ESC/Ctrl+[ or the sidebar back button calls `closeSecondaryPage()`.
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
