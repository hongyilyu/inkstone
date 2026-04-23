import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { KiroCredentials } from "pi-kiro/core";

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
 * alongside Kiro without a migration.
 */

const CONFIG_DIR = join(
	process.env.XDG_CONFIG_HOME || join(process.env.HOME || "~", ".config"),
	"inkstone",
);
const AUTH_FILE = join(CONFIG_DIR, "auth.json");

interface AuthFile {
	kiro?: KiroCredentials;
}

let cached: AuthFile | null = null;

function load(): AuthFile {
	if (cached) return cached;
	if (!existsSync(AUTH_FILE)) {
		cached = {};
		return cached;
	}
	try {
		const raw = readFileSync(AUTH_FILE, "utf-8");
		cached = JSON.parse(raw) as AuthFile;
		return cached;
	} catch {
		cached = {};
		return cached;
	}
}

function save(data: AuthFile): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	}
	writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), {
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
	cached = data;
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
