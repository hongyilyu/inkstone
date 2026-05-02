/**
 * Test preload — runs before any test file is loaded.
 *
 * Wired via `bunfig.toml` → `[test] preload = ["./test/preload.ts"]`.
 * Must set up the XDG config root and vault skeleton *before* any
 * `import` from `@backend/*` resolves:
 *
 * - `backend/persistence/paths.ts` reads `process.env.XDG_CONFIG_HOME`
 *   at module-eval.
 * - `backend/agent/constants.ts` calls `loadConfig()` at module-eval,
 *   which reads from `CONFIG_FILE` derived from above.
 *
 * A `beforeAll` in a test file would be too late — the test file's
 * static imports resolve before `beforeAll` runs.
 *
 * This file stays pure Node stdlib (no `@backend/*` imports) so the
 * capture order stays correct. Test files that need the vault paths
 * import `VAULT` / `ARTICLES_DIR` from here.
 */

import { afterAll } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Isolated tmp dir per test process. Keeps parallel runs from colliding.
const ROOT = mkdtempSync(join(tmpdir(), "inkstone-test-"));

// XDG roots — Inkstone reads XDG_CONFIG_HOME for config.json and
// XDG_STATE_HOME for the SQLite DB.
const CONFIG_HOME = join(ROOT, "config");
const STATE_HOME = join(ROOT, "state");
const VAULT = join(ROOT, "vault");

mkdirSync(join(CONFIG_HOME, "inkstone"), { recursive: true });
mkdirSync(STATE_HOME, { recursive: true });
mkdirSync(VAULT, { recursive: true });

process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.env.XDG_STATE_HOME = STATE_HOME;

// Seed an OpenRouter API key so tests that depend on at-least-one
// connected provider (e.g. Connect dialog rendering `✓`, Select Model
// populating OpenRouter's catalog, rehome-on-disconnect) have a
// hermetic fixture. Previously this file seeded `AWS_PROFILE=default`
// for Amazon Bedrock's `hasAwsSharedConfig()` branch; Bedrock is gone
// and every shipped provider now requires explicit credentials, so
// we write OpenRouter's auth.json entry directly.
//
// Writing the JSON file raw (rather than calling `saveOpenRouterKey`)
// preserves this preload's no-`@backend/*`-imports invariant — the
// comment block above explains why those imports can't happen before
// backend modules resolve. `auth.json` shape is stable (see
// `src/backend/persistence/schema.ts` AuthFile: `{ openrouter?: string }`),
// so the raw write is safe.
writeFileSync(
	join(CONFIG_HOME, "inkstone", "auth.json"),
	JSON.stringify({ openrouter: "sk-or-v1-test" }, null, 2),
	{ mode: 0o600 },
);

// Write config.json pointing at the tmp vault. This has to happen
// before `backend/persistence/config.ts` is loaded (it caches at
// module-eval via `loadConfig()`).
writeFileSync(
	join(CONFIG_HOME, "inkstone", "config.json"),
	JSON.stringify({ vaultDir: VAULT }, null, 2),
);

// Seed the Articles folder so reader's `/article` command has files
// to find. Matches the layout reader's zones declare
// (`010 RAW/013 Articles`).
const ARTICLES_DIR = resolve(VAULT, "010 RAW/013 Articles");
mkdirSync(ARTICLES_DIR, { recursive: true });

writeFileSync(
	resolve(ARTICLES_DIR, "foo.md"),
	`---\ntitle: foo\nreading_intent: keeper\n---\n\nBody paragraph.\n`,
);
writeFileSync(
	resolve(ARTICLES_DIR, "bar.md"),
	`---\ntitle: bar\n---\n\nAnother article body.\n`,
);

// Symlink inside Articles pointing outside the vault — exercises the
// `lstatSync` symlink-reject guard in reader's `/article` command.
symlinkSync("/etc/hosts", resolve(ARTICLES_DIR, "sneak.md"));

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

export { ARTICLES_DIR, CONFIG_HOME, ROOT, STATE_HOME, VAULT };
