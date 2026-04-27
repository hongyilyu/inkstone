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
 * overlay. Custom rules come first, zones come second.
 *
 * Rationale: zones emit lenient, directory-scoped `confirmDirs` that
 * cover whole workspaces. Custom rules (from `getPermissions`) are
 * typically stricter and file- or shape-specific. With first-block-wins
 * in the dispatcher, the stricter rules must evaluate first for two
 * reasons:
 *
 *   1. For legitimate calls that both rules would let through, the
 *      custom rule returns `undefined` (pass) and the zone's
 *      `confirmDirs` then fires exactly once — one user prompt per
 *      legitimate write. Example: reader editing article frontmatter —
 *      the `frontmatterOnlyInDirs` rule passes, then the zone
 *      confirms.
 *
 *   2. For calls the custom rule would reject outright, putting it
 *      first means the block wins without a wasted prompt. Example:
 *      reader blocking a `write` against any article via
 *      `blockInsideDirs` — the zone's confirm prompt never fires for a
 *      call that's guaranteed to fail anyway.
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
