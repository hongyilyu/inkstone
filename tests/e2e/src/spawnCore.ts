import { type ChildProcess, spawn } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Spawn-and-drive primitive for the full-system Test Harness (ADR-0019): fresh Core + built SPA + gate-fixture Worker. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

export const CORE_BIN = path.join(REPO_ROOT, "target", "debug", "core");
export const WEB_DIST = path.join(REPO_ROOT, "apps", "web", "dist");

/** Compiled FIXTURE worker binary (ADR-0041 step 2, slice 3). `global-setup.ts`
 * bun-compiles the deterministic slow-worker to this NON-real name — NOT
 * `inkstone-worker`, which would sit next to `target/debug/core` and make
 * `pnpm dev` (and every no-override spec) auto-detect+spawn the echo fixture
 * instead of the real Worker. The hermetic `siblingBinaries.worker` mode below
 * copies it to the real `inkstone-worker` name ONLY inside a per-test tempdir. */
export const WORKER_FIXTURE_BIN = path.join(
	REPO_ROOT,
	"target",
	"debug",
	"inkstone-worker-fixture",
);

/** Compiled FIXTURE provider-helper binary (ADR-0041 step 2, slice 4). Same
 * FOOTGUN as {@link WORKER_FIXTURE_BIN}: `global-setup.ts` bun-compiles the
 * offline `login-helper.ts` fixture to this NON-real name — NOT
 * `inkstone-provider-helper`, which would sit next to `target/debug/core` and
 * hijack real `provider/login_start` in `pnpm dev`. The hermetic
 * `siblingBinaries.providerHelper` mode below copies it to the real
 * `inkstone-provider-helper` name ONLY inside a per-test tempdir. */
export const PROVIDER_HELPER_FIXTURE_BIN = path.join(
	REPO_ROOT,
	"target",
	"debug",
	"inkstone-provider-helper-fixture",
);
const TSX_BIN = path.join(
	REPO_ROOT,
	"packages",
	"worker",
	"node_modules",
	".bin",
	"tsx",
);
const FIXTURE = path.join(
	REPO_ROOT,
	"crates",
	"core",
	"tests",
	"fixtures",
	"slow-worker.ts",
);

/** The worker command Core spawns: tsx running the gate fixture. */
export const GATE_WORKER_CMD = `${TSX_BIN} ${FIXTURE}`;

const PROPOSE_WORKER_TS = path.join(
	REPO_ROOT,
	"crates",
	"core",
	"tests",
	"fixtures",
	"propose-worker.ts",
);

/** Direct Worker fixture that emits `propose_workspace_mutation` without LLM validation. */
export const PROPOSE_WORKER_CMD = `${TSX_BIN} ${PROPOSE_WORKER_TS}`;

const PROMPT_BOUNDARY_WORKER_TS = path.join(
	REPO_ROOT,
	"crates",
	"core",
	"tests",
	"fixtures",
	"prompt-boundary-worker.ts",
);

/** Worker fixture that guards the shipped prompt's reminder-vs-journal boundary. */
export const PROMPT_BOUNDARY_WORKER_CMD = `${TSX_BIN} ${PROMPT_BOUNDARY_WORKER_TS}`;

const LOGIN_HELPER_FIXTURE = path.join(
	REPO_ROOT,
	"crates",
	"core",
	"tests",
	"fixtures",
	"login-helper.ts",
);

/** Offline provider-login helper Core runs for `provider/login_start` (ADR-0019/0023): emits authorize URL then credentials. */
export const LOGIN_HELPER_CMD = `${TSX_BIN} ${LOGIN_HELPER_FIXTURE} login`;

const FAUX_WORKER_TS = path.join(
	REPO_ROOT,
	"packages",
	"worker",
	"src",
	"faux",
	"faux-worker.ts",
);

/** TEST-ONLY faux interpreter worker command: drives the real pi-agent-core loop offline via an env-scripted faux provider. */
export const FAUX_WORKER_CMD = `${TSX_BIN} ${FAUX_WORKER_TS}`;

export interface SpawnCoreOptions {
	/** Bind port. Default 0 → OS-assigned ephemeral (avoids cross-test collisions). */
	readonly port?: number;
	/** Serve the SPA from this dir. Default the built `apps/web/dist`. */
	readonly webDir?: string;
	/** Worker command. Default the gate fixture; set to undefined to use Core's default. */
	readonly workerCmd?: string;
	/** Hermetic sibling-binary mode (ADR-0041 step 2): run Core from an isolated
	 * tempdir with compiled sibling binaries next to it and NO `INKSTONE_*_CMD`
	 * override, so Core's resolver auto-detects them via `current_exe`'s
	 * directory. `worker` is a path to a compiled worker binary (e.g.
	 * {@link WORKER_FIXTURE_BIN}); when set, `INKSTONE_WORKER_CMD` is left UNSET
	 * (and scrubbed from the inherited env) and `workerCmd` is ignored.
	 * `providerHelper` is a path to a compiled provider-helper binary (e.g.
	 * {@link PROVIDER_HELPER_FIXTURE_BIN}); when set, `INKSTONE_PROVIDER_LOGIN_CMD`
	 * is left UNSET (and scrubbed) and `providerLoginCmd` is ignored. Both may be
	 * set together — one tempdir hosts both siblings. */
	readonly siblingBinaries?: {
		readonly worker?: string;
		readonly providerHelper?: string;
	};
	/** Gate-fixture chunk count: `chunks` > 1 splits `echo: <prompt>` into deltas and pauses after chunk 1 until the gate file exists. */
	readonly chunks?: number;
	readonly gatePath?: string;
	/** Provider-login helper Core runs for `provider/login_start` (ADR-0023); maps to `INKSTONE_PROVIDER_LOGIN_CMD`. */
	readonly providerLoginCmd?: string;
	/** Canned faux-provider response (`INKSTONE_FAUX_RESPONSE`); with `FAUX_WORKER_CMD` drives a real offline interpreter completion. */
	readonly fauxResponse?: string;
	/** Makes the faux provider fail the turn with this message (`INKSTONE_FAUX_ERROR`), producing a real `error` Run Event. */
	readonly fauxError?: string;
	/** Drive the faux provider in `read_thread` tool-call mode (`INKSTONE_FAUX_TOOL_CALL`), exercising the full Tool Protocol round-trip. */
	readonly fauxToolCall?: boolean;
	/** Drive the faux provider to call the ambient `load_skill` tool by this name (`INKSTONE_FAUX_LOAD_SKILL`, ADR-0036), exercising Skills activation end-to-end. */
	readonly fauxLoadSkill?: string;
	/** Skills directory (`INKSTONE_SKILLS_DIR`, ADR-0036). Defaulted into the Workspace tempdir so boot's seed_if_absent stays hermetic and tests can pre-seed it. */
	readonly skillsDir?: string;
	/** Higher-level faux interpreter mode: `propose` (Journal Entry mutations, ADR-0025), `extract` (Person/Project/Todo extraction from an accepted Journal Entry), or `capture` (direct GTD capture sourced from the user Message — no Journal Entry). Drives the park -> decide -> resume loop. */
	readonly faux?: "propose" | "extract" | "capture";
	/** Direct propose-worker fixture knob. Emits params loaded from this JSON file. */
	readonly proposalParamsFile?: string;
	/** Faux extraction scenario (`INKSTONE_FAUX_EXTRACT_PARAMS`): `{ journal_text, person_name }` JSON file the extract mode reads. */
	readonly extractParamsFile?: string;
	/** Faux direct-capture scenario (`INKSTONE_FAUX_CAPTURE_PARAMS`): `{ intent, todo?, project?, person?, enrich? }` JSON file the capture mode reads. */
	readonly captureParamsFile?: string;
	/** Optional JSONL path where Worker proxy writes model tool-call params. */
	readonly workerToolCallLogPath?: string;
	/** Milliseconds to wait for the listening line before failing. Default 30s. */
	readonly startupTimeoutMs?: number;
}

export interface SpawnedCore {
	/** `http://127.0.0.1:<port>` — the base URL of the served SPA + `/ws`. */
	readonly url: string;
	/** The tempdir Workspace (DB lives at `<workspaceDir>/db.sqlite`). */
	readonly workspaceDir: string;
	/** The Diagnostic Log dir (ADR-0038): `core.jsonl` + sibling `worker.jsonl`
	 * land here. Defaulted into the Workspace tempdir so e2e runs stay hermetic
	 * (no writes to the dev/CI OS data dir). */
	readonly logDir: string;
	/** Release the gate so the fixture streams its remaining chunks + done. */
	tripGate(): void;
	/** SIGTERM Core, wait for exit, and remove the tempdir Workspace. */
	shutdown(): Promise<void>;
}

/** Resolve once Core prints `INKSTONE_LISTENING <url>`, or reject on timeout/exit. */
function awaitListening(
	child: ChildProcess,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(
				new Error(
					`Core did not announce INKSTONE_LISTENING within ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			buf += chunk;
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				const m = line.match(/^INKSTONE_LISTENING (\S+)/);
				if (m) {
					finish(() => resolve(m[1]));
					return;
				}
				nl = buf.indexOf("\n");
			}
		});
		// Tee Core (and Worker, inherited) stderr so harness failures are visible.
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			process.stderr.write(`[core] ${chunk}`);
		});
		child.on("exit", (code, signal) => {
			finish(() =>
				reject(
					new Error(
						`Core exited before announcing INKSTONE_LISTENING (code=${code}, signal=${signal})`,
					),
				),
			);
		});
		child.on("error", (err) => finish(() => reject(err)));
	});
}

export async function spawnCore(
	opts: SpawnCoreOptions = {},
): Promise<SpawnedCore> {
	const workspaceDir = mkdtempSync(path.join(tmpdir(), "inkstone-test-"));
	const dbPath = path.join(workspaceDir, "db.sqlite");
	// Pin the Diagnostic Log dir (ADR-0038) into the tempdir so e2e runs don't
	// write core.jsonl/worker.jsonl into the dev/CI OS data dir — and so a test
	// can read the trail back. Core defaults the Worker's INKSTONE_WORKER_LOG_PATH
	// to <logDir>/worker.jsonl from this.
	const logDir = path.join(workspaceDir, "logs");

	const chunks = opts.chunks ?? 1;
	const gatePath =
		opts.gatePath ?? (chunks > 1 ? path.join(workspaceDir, "gate") : undefined);

	// Default the skills dir (ADR-0036) into the tempdir so boot's seed_if_absent
	// writes the bundled skills there (hermetic — never the dev/CI OS data dir),
	// and a test can pre-seed it. Per-opt override still wins below.
	const skillsDir = opts.skillsDir ?? path.join(workspaceDir, "skills");

	const env: NodeJS.ProcessEnv = {
		...process.env,
		INKSTONE_DB_PATH: dbPath,
		INKSTONE_PORT: String(opts.port ?? 0),
		INKSTONE_WEB_DIR: opts.webDir ?? WEB_DIST,
		INKSTONE_LOG_DIR: logDir,
		INKSTONE_SKILLS_DIR: skillsDir,
	};

	// Strip inherited INKSTONE_FAUX_* so an ambient value can't leak one test's mode into another.
	for (const key of [
		"INKSTONE_FAUX_RESPONSE",
		"INKSTONE_FAUX_ERROR",
		"INKSTONE_FAUX_TOOL_CALL",
		"INKSTONE_FAUX_LOAD_SKILL",
		"INKSTONE_FAUX_PROPOSE",
		"INKSTONE_FAUX_EXTRACT",
		"INKSTONE_FAUX_EXTRACT_PARAMS",
		"INKSTONE_FAUX_CAPTURE",
		"INKSTONE_FAUX_CAPTURE_PARAMS",
		"INKSTONE_FAUX_ECHO_HISTORY",
		"INKSTONE_PROPOSE_PARAMS_FILE",
		"INKSTONE_WORKER_TOOL_CALL_LOG",
	]) {
		delete env[key];
	}

	// Hermetic sibling-binary mode (ADR-0041 step 2): copy Core + whichever
	// compiled sibling binaries are provided into ONE isolated tempdir so
	// `current_exe().parent()` finds them, and leave the corresponding
	// `INKSTONE_*_CMD` override(s) UNSET (scrubbed from the inherited env too) so
	// Core's resolver auto-detects each sibling rather than honoring an override.
	// Worker and provider-helper siblings are independent: either, both, or
	// neither may be set.
	const siblingWorker = opts.siblingBinaries?.worker;
	const siblingProviderHelper = opts.siblingBinaries?.providerHelper;
	const usingSiblings =
		siblingWorker !== undefined || siblingProviderHelper !== undefined;
	let binDir: string | undefined;
	let coreBin = CORE_BIN;
	if (usingSiblings) {
		binDir = mkdtempSync(path.join(tmpdir(), "inkstone-bin-"));
		coreBin = path.join(binDir, "core");
		copyFileSync(CORE_BIN, coreBin);
		chmodSync(coreBin, 0o755);
		if (siblingWorker !== undefined) {
			const siblingDest = path.join(binDir, "inkstone-worker");
			copyFileSync(siblingWorker, siblingDest);
			chmodSync(siblingDest, 0o755);
			// Auto-detection only fires when NO override is set. Scrub any inherited
			// value so nothing leaks through `...process.env`.
			delete env.INKSTONE_WORKER_CMD;
			// The fixture honors INKSTONE_FIXTURE_CHUNKS/GATE on stdin like the tsx
			// form does, so the gate/chunk knobs still work through the sibling.
			env.INKSTONE_FIXTURE_CHUNKS = String(chunks);
			if (gatePath) env.INKSTONE_FIXTURE_GATE = gatePath;
		}
		if (siblingProviderHelper !== undefined) {
			const helperDest = path.join(binDir, "inkstone-provider-helper");
			copyFileSync(siblingProviderHelper, helperDest);
			chmodSync(helperDest, 0o755);
			// Auto-detection only fires when NO override is set. Scrub the inherited
			// value and DON'T re-set it from opts.providerLoginCmd below.
			delete env.INKSTONE_PROVIDER_LOGIN_CMD;
			// The compiled login-helper fixture reads INKSTONE_LOGIN_STUB_URL from its
			// (inherited) env; point it at about:blank so the SPA's window.open of the
			// authorize URL is harmless in headless Chromium.
			env.INKSTONE_LOGIN_STUB_URL = "about:blank";
		}
	}
	// The worker command is independent of the provider-helper sibling: configure
	// it whenever NO worker sibling is in play (the plain non-sibling case AND the
	// provider-helper-only sibling case). Skipped only when a worker sibling was
	// copied above (which deliberately auto-detects via NO override). Without this,
	// `siblingBinaries: { providerHelper }` alone would drop both opts.workerCmd and
	// the GATE_WORKER_CMD default, leaving the tempdir Core with no worker to spawn.
	if (siblingWorker === undefined) {
		const workerCmd =
			opts.workerCmd !== undefined ? opts.workerCmd : GATE_WORKER_CMD;
		if (workerCmd) {
			env.INKSTONE_WORKER_CMD = workerCmd;
			env.INKSTONE_FIXTURE_CHUNKS = String(chunks);
			if (gatePath) env.INKSTONE_FIXTURE_GATE = gatePath;
			if (opts.proposalParamsFile !== undefined) {
				env.INKSTONE_PROPOSE_PARAMS_FILE = opts.proposalParamsFile;
			}
			if (opts.workerToolCallLogPath !== undefined) {
				env.INKSTONE_WORKER_TOOL_CALL_LOG = opts.workerToolCallLogPath;
			}
		}
	}

	// Per-test credential store so provider/status starts disconnected and a login e2e can observe it flip to connected.
	env.INKSTONE_CREDENTIALS_DIR = path.join(workspaceDir, "credentials");
	// In provider-helper sibling mode the override is deliberately UNSET (scrubbed
	// above) so Core auto-detects the sibling; never re-set it from providerLoginCmd.
	if (
		siblingProviderHelper === undefined &&
		opts.providerLoginCmd !== undefined
	) {
		env.INKSTONE_PROVIDER_LOGIN_CMD = opts.providerLoginCmd;
	}

	// Faux-interpreter mode: write a provider="faux" Workflow and feed the canned response/error/mode to the faux provider (ADR-0019 faux seam).
	if (
		opts.fauxResponse !== undefined ||
		opts.fauxError !== undefined ||
		opts.fauxToolCall ||
		opts.fauxLoadSkill !== undefined ||
		opts.faux !== undefined
	) {
		const workflowsDir = path.join(workspaceDir, "workflows");
		mkdirSync(workflowsDir, { recursive: true });
		// load_skill is AMBIENT (ADR-0036) — deliberately NOT listed here, so the
		// e2e proves Core adds it to the manifest + dispatches it despite an empty
		// Workflow allowlist.
		const tools = opts.fauxToolCall
			? '["read_thread"]'
			: opts.faux === "propose"
				? '["read_thread","read_current_thread_journal_entries","propose_workspace_mutation"]'
				: opts.faux === "extract" || opts.faux === "capture"
					? '["read_thread","read_current_thread_journal_entries","search_entities","propose_workspace_mutation"]'
					: "[]";
		writeFileSync(
			path.join(workflowsDir, "default.toml"),
			[
				'name = "default"',
				'version = "1.0.0"',
				'provider = "faux"',
				'model = "faux-1"',
				// Deliberately NO `thinking_level` — regression guard for resume's `resolve_effective_workflow`; see docs/design/e2e-tests.md
				'system_prompt = "You are a test assistant."',
				`tools = ${tools}`,
				"",
			].join("\n"),
		);
		env.INKSTONE_WORKFLOWS_DIR = workflowsDir;
		if (opts.fauxToolCall) {
			env.INKSTONE_FAUX_TOOL_CALL = "1";
		} else if (opts.fauxLoadSkill !== undefined) {
			env.INKSTONE_FAUX_LOAD_SKILL = opts.fauxLoadSkill;
		} else if (opts.faux === "propose") {
			env.INKSTONE_FAUX_PROPOSE = "1";
		} else if (opts.faux === "extract") {
			env.INKSTONE_FAUX_EXTRACT = "1";
			if (opts.extractParamsFile !== undefined) {
				env.INKSTONE_FAUX_EXTRACT_PARAMS = opts.extractParamsFile;
			}
		} else if (opts.faux === "capture") {
			env.INKSTONE_FAUX_CAPTURE = "1";
			if (opts.captureParamsFile !== undefined) {
				env.INKSTONE_FAUX_CAPTURE_PARAMS = opts.captureParamsFile;
			}
		} else if (opts.fauxError !== undefined) {
			env.INKSTONE_FAUX_ERROR = opts.fauxError;
		} else if (opts.fauxResponse !== undefined) {
			env.INKSTONE_FAUX_RESPONSE = opts.fauxResponse;
		}
	}

	// Own process group (detached) so shutdown can hard-kill orphaned Worker children alongside Core.
	// `coreBin` is the isolated tempdir copy in sibling-binary mode, else target/debug/core.
	// cwd stays REPO_ROOT (current_exe — and thus sibling detection — is cwd-independent;
	// the tsx fallback's repo-relative paths still resolve here for non-sibling specs).
	const child = spawn(coreBin, [], {
		cwd: REPO_ROOT,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});

	let url: string;
	try {
		url = await awaitListening(child, opts.startupTimeoutMs ?? 30_000);
	} catch (err) {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {
			// already gone
		}
		rmSync(workspaceDir, { recursive: true, force: true });
		if (binDir) rmSync(binDir, { recursive: true, force: true });
		throw err;
	}

	return {
		url,
		workspaceDir,
		logDir,
		tripGate() {
			if (!gatePath) {
				throw new Error(
					"tripGate() called but no gate is configured (spawn with chunks > 1)",
				);
			}
			writeFileSync(gatePath, "go");
		},
		async shutdown() {
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					resolve();
					return;
				}
				const killTimer = setTimeout(() => {
					try {
						if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
					} catch {
						// already gone
					}
				}, 5_000);
				child.on("exit", () => {
					clearTimeout(killTimer);
					resolve();
				});
				try {
					if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
					else child.kill("SIGTERM");
				} catch {
					clearTimeout(killTimer);
					resolve();
				}
			});
			rmSync(workspaceDir, { recursive: true, force: true });
			if (binDir) rmSync(binDir, { recursive: true, force: true });
		},
	};
}
