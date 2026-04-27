import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { KiroCredentials } from "pi-kiro/core";
import { z } from "zod";

/**
 * Zod schemas for files persisted by `src/backend/config/`.
 *
 * These schemas are the runtime boundary between "what the user / previous
 * Inkstone version wrote to disk" and "what the rest of the backend trusts".
 * They intentionally mirror the hand-written TS shapes we used to ship; Zod
 * is here to add field-level validation and surface typos via `.strictObject`,
 * not to widen the persisted API.
 */

/**
 * Re-statement of pi-agent-core's `ThinkingLevel` union as a Zod enum.
 *
 * `satisfies z.ZodType<ThinkingLevel>` is the compile-time tripwire: if
 * pi-agent-core ever widens the union (e.g. adds "ultra"), this line stops
 * compiling and we notice before values silently get dropped at runtime.
 */
const ThinkingLevelSchema = z.enum([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]) satisfies z.ZodType<ThinkingLevel>;

/**
 * `~/.config/inkstone/config.json` shape.
 *
 * `strictObject` so unknown top-level keys produce a named validation issue
 * (e.g. `Unrecognized key: "themId"`) instead of silently disappearing when
 * the user has a typo in a hand-edited config.
 */
export const Config = z.strictObject({
	providerId: z.string().optional(),
	modelId: z.string().optional(),
	themeId: z.string().optional(),
	currentAgent: z.string().optional(),
	thinkingLevels: z.record(z.string(), ThinkingLevelSchema).optional(),
	vaultDir: z.string().optional(),
});
export type Config = z.infer<typeof Config>;

/**
 * `~/.config/inkstone/auth.json` shape.
 *
 * `kiro` uses `z.custom<KiroCredentials>()` with a null-and-object guard.
 * pi-kiro owns the credential shape and we treat it as opaque — nothing in
 * Inkstone reads individual fields — but we still have to reject `null`
 * and primitives explicitly, because `z.custom<T>()` with no predicate
 * accepts literally anything. Without the guard, `{"kiro": null}` on disk
 * would survive parsing, `loadKiroCreds()` would return `null`, and
 * `isConnected()` (`loadKiroCreds() !== undefined`) would wrongly report
 * "connected" until the next refresh tried to read `creds.expires`.
 * The top-level `strictObject` additionally catches key typos.
 */
export const AuthFile = z.strictObject({
	kiro: z
		.custom<KiroCredentials>(
			(v) => v !== null && typeof v === "object" && !Array.isArray(v),
			{ error: "expected a KiroCredentials object" },
		)
		.optional(),
});
export type AuthFile = z.infer<typeof AuthFile>;
