/**
 * Full-screen secondary page. Replaces the conversation area when
 * a secondary page is open. Renders file markdown from disk in a
 * scrollable main area.
 *
 * Navigation: ESC/Ctrl+[ or the sidebar back button calls `closeSecondaryPage()`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VAULT_DIR } from "@backend/agent/constants";
import { isInsideDir } from "@backend/agent/permissions";
import { createMemo } from "solid-js";
import { getSecondaryPage } from "../app";
import { useTheme } from "../context/theme";

export function ArticlePage() {
	const { theme, syntax } = useTheme();

	const content = createMemo(() => {
		const page = getSecondaryPage();
		if (!page) return "";
		try {
			const abs = resolve(VAULT_DIR, page.filename);
			// Sandbox check — reject paths that escape the vault.
			if (!isInsideDir(abs, VAULT_DIR) || abs === VAULT_DIR) {
				return `_Path outside vault: ${page.filename}_`;
			}
			return readFileSync(abs, "utf-8");
		} catch {
			return `_Could not read file: ${page.filename}_`;
		}
	});

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
