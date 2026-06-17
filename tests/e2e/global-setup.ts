import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
	CORE_BIN,
	REPO_ROOT,
	WEB_DIST,
	WORKER_FIXTURE_BIN,
} from "./src/spawnCore.js";

/** Path to the deterministic slow-worker fixture that bun-compiles into {@link WORKER_FIXTURE_BIN}. */
const SLOW_WORKER_FIXTURE = path.join(
	REPO_ROOT,
	"crates",
	"core",
	"tests",
	"fixtures",
	"slow-worker.ts",
);

/** Playwright global setup (ADR-0019): build debug Core + Web Client SPA once per run so `spawnCore` has real artifacts. */
export default function globalSetup(): void {
	const run = (cmd: string, args: string[]) => {
		execFileSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit" });
	};

	// Core (debug): the harness spawns target/debug/core.
	run("cargo", ["build", "--manifest-path", "crates/core/Cargo.toml"]);
	if (!existsSync(CORE_BIN)) {
		throw new Error(`cargo build did not produce ${CORE_BIN}`);
	}

	// Web Client SPA: Core serves it via INKSTONE_WEB_DIR.
	run("pnpm", ["-C", "apps/web", "build"]);
	if (!existsSync(path.join(WEB_DIST, "index.html"))) {
		throw new Error(`web build did not produce ${WEB_DIST}/index.html`);
	}

	// Compiled FIXTURE worker binary (ADR-0041 step 2): bun-compile the
	// deterministic slow-worker once per run. The compiled-worker.spec copies
	// it into a per-test tempdir under the REAL `inkstone-worker` name so Core
	// auto-detects + spawns it. Compiled to a NON-real name so it can never sit
	// next to `target/debug/core` and hijack `pnpm dev` / no-override specs.
	run("bun", [
		"build",
		"--compile",
		SLOW_WORKER_FIXTURE,
		"--outfile",
		WORKER_FIXTURE_BIN,
	]);
	if (!existsSync(WORKER_FIXTURE_BIN)) {
		throw new Error(
			`bun build --compile did not produce ${WORKER_FIXTURE_BIN}`,
		);
	}
}
