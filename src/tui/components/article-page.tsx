/**
 * Full-screen article reader page. Replaces the conversation area when
 * `store.articleView` is non-null. Renders the article markdown from
 * disk in a scrollable main area.
 *
 * Navigation: Ctrl+[ or the sidebar back button calls `actions.closeArticle()`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VAULT_DIR } from "@backend/agent/constants";
import { isInsideDir } from "@backend/agent/permissions";
import { createMemo } from "solid-js";
import { useAgent } from "../context/agent";
import { useTheme } from "../context/theme";

export function ArticlePage() {
	const { store } = useAgent();
	const { theme, syntax } = useTheme();

	const content = createMemo(() => {
		const view = store.articleView;
		if (!view) return "";
		try {
			const abs = resolve(VAULT_DIR, view.filename);
			// Sandbox check — reject paths that escape the vault.
			if (!isInsideDir(abs, VAULT_DIR) || abs === VAULT_DIR) {
				return `_Path outside vault: ${view.filename}_`;
			}
			return readFileSync(abs, "utf-8");
		} catch {
			return `_Could not read file: ${view.filename}_`;
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
