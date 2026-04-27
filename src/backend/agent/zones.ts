import { isAbsolute, join } from "node:path";
import { VAULT_DIR } from "./constants";
import type { AgentOverlay, Rule } from "./permissions";
import { editTool, writeTool } from "./tools";
import type { AgentInfo } from "./types";

/**
 * Derive a permission overlay from an agent's zones. Produces rules
 * for the two mutating tools (`edit`, `write`) that the reader cares
 * about today; if a future agent composes additional mutating tools,
 * extend the key set.
 *
 * Policy by `AgentZone.write`:
 *   - `auto`    — no rule needed; writes inside this zone pass through
 *                 the vault baseline unchanged.
 *   - `confirm` — emit a `confirmDirs` rule listing the zone path.
 *
 * Zone paths are joined with `VAULT_DIR` via `node:path.join` so
 * leading/trailing slashes normalize. Absolute paths and paths containing
 * `..` segments are rejected at compose time to catch misconfiguration
 * loudly — a zone `/etc` or `../etc` would otherwise produce a path
 * outside the vault, and silent failure would leave the zone inert
 * (or worse, apply its `confirm`-semantics to something the agent was
 * never meant to touch).
 *
 * Returns an empty overlay for agents with no zones (example agent).
 */
export function composeZonesOverlay(info: AgentInfo): AgentOverlay {
	if (info.zones.length === 0) return {};

	const confirmPaths: string[] = [];
	for (const zone of info.zones) {
		// Reject absolute paths cross-platform. `isAbsolute` covers POSIX
		// (`/etc`), Windows drive-letter (`C:\foo`), and UNC (`\\server\share`)
		// when run under Windows. A plain `startsWith("/")` would miss the
		// latter two.
		if (isAbsolute(zone.path)) {
			throw new Error(
				`Zone path must be vault-relative, got absolute path: '${zone.path}' on agent '${info.name}'.`,
			);
		}
		// Reject `..` segments on both separator styles so a Windows-authored
		// zone like `"..\\etc"` doesn't slip past a POSIX-only split.
		if (zone.path.split(/[/\\]/).some((seg) => seg === "..")) {
			throw new Error(
				`Zone path must not escape the vault via '..' segments: '${zone.path}' on agent '${info.name}'.`,
			);
		}
		if (zone.write === "confirm") {
			confirmPaths.push(join(VAULT_DIR, zone.path));
		}
	}

	const overlay: AgentOverlay = {};
	if (confirmPaths.length > 0) {
		const rule: Rule = { kind: "confirmDirs", dirs: confirmPaths };
		overlay[writeTool.name] = [rule];
		overlay[editTool.name] = [rule];
	}
	return overlay;
}

/**
 * Merge the agent's optional custom overlay with the zones-derived
 * overlay. Custom rules come first (stricter escape hatches) so the
 * dispatcher's first-block-wins evaluation short-circuits on them
 * before the zone-level confirm prompts fire.
 *
 * Concrete case: reader's active article lives inside the Articles
 * zone (confirmDirs). A `write` against it should block outright
 * (custom `blockPath`), not confirm-then-block. Putting custom rules
 * first lets the block win without a wasted prompt. An `edit` of
 * frontmatter should pass without a confirm prompt because
 * `frontmatterOnlyFor` evaluates first and returns `undefined` (pass);
 * only then does the zone's `confirmDirs` fire. Net: confirm only
 * when no custom rule has an opinion.
 *
 * Keys with rules in both overlays are concatenated; custom first,
 * zones second.
 */
export function composeOverlay(info: AgentInfo): AgentOverlay {
	const zones = composeZonesOverlay(info);
	const custom = info.getPermissions?.() ?? {};
	const merged: AgentOverlay = { ...custom };
	for (const [toolName, rules] of Object.entries(zones)) {
		if (!rules) continue;
		merged[toolName] = [...(merged[toolName] ?? []), ...rules];
	}
	return merged;
}
