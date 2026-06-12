import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { CORE_BIN, REPO_ROOT, WEB_DIST } from "./src/spawnCore.js";

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
}
