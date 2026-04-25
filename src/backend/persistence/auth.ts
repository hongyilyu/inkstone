import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import type { KiroCredentials } from "pi-kiro/core";
import { reportPersistenceError } from "./errors";
import { AUTH_FILE, CONFIG_DIR } from "./paths";
import { AuthFile, type AuthFile as AuthFileType } from "./schema";

/**
 * Credential storage for OAuth providers.
 *
 * Kept separate from `config.json` because these tokens are sensitive —
 * pi-kiro's docstring (`src/oauth.ts:55-72`) explicitly calls out the
 * refresh token + clientSecret pair as "persist only to secure storage,
 * do not log, do not embed in URLs". config.json is frequently screenshared
 * (themes, model ids, etc.) so a split avoids accidental leaks.
 *
 * File mode: 0600 (owner read/write only). Directory: 0700. Matches pi's
 * own `~/.pi/agent/auth.json` convention.
 *
 * Shape is keyed by provider id so future interactive providers slot in
 * alongside Kiro without a migration. Parsing goes through the Zod schema
 * in `./schema.ts` so unknown top-level keys surface as validation errors
 * instead of being silently discarded.
 */

let cached: AuthFileType | null = null;

function load(): AuthFileType {
	if (cached) return cached;
	if (!existsSync(AUTH_FILE)) {
		cached = {};
		return cached;
	}
	try {
		const raw = readFileSync(AUTH_FILE, "utf-8");
		const parsed = AuthFile.safeParse(JSON.parse(raw));
		if (parsed.success) {
			cached = parsed.data;
			return cached;
		}
		const details = parsed.error.issues
			.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
			.join("\n");
		reportPersistenceError({
			kind: "auth",
			action: "load",
			error: new Error(`invalid auth.json:\n${details}`),
		});
		cached = {};
		return cached;
	} catch (error) {
		reportPersistenceError({ kind: "auth", action: "load", error });
		cached = {};
		return cached;
	}
}

function save(data: AuthFileType): void {
	// Validate before writing — symmetric with `saveConfig` and catches the
	// case where a caller accidentally passes a non-object (e.g. `null`) as
	// creds. Without this, the bad value would round-trip through the file
	// and only fail on the next load via the custom predicate in schema.ts.
	const parsed = AuthFile.safeParse(data);
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
			.join("\n");
		reportPersistenceError({
			kind: "auth",
			action: "save",
			error: new Error(`refusing to save invalid auth.json:\n${details}`),
		});
		return;
	}
	try {
		if (!existsSync(CONFIG_DIR)) {
			mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
		}
		writeFileSync(AUTH_FILE, JSON.stringify(parsed.data, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});
		// writeFileSync only honors `mode` on file creation; a subsequent write
		// leaves the existing mode intact. chmod unconditionally so pre-existing
		// world-readable files from earlier versions get tightened.
		try {
			chmodSync(AUTH_FILE, 0o600);
		} catch {
			// Best-effort — chmod can fail on Windows or exotic filesystems.
		}
		cached = parsed.data;
	} catch (error) {
		reportPersistenceError({ kind: "auth", action: "save", error });
	}
}

export function loadKiroCreds(): KiroCredentials | undefined {
	return load().kiro;
}

export function saveKiroCreds(creds: KiroCredentials): void {
	const current = load();
	save({ ...current, kiro: creds });
}

export function clearKiroCreds(): void {
	const current = load();
	const next = { ...current };
	delete next.kiro;
	save(next);
}
