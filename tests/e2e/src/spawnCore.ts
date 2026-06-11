import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spawn-and-drive primitive for the full-system Test Harness (ADR-0019).
 *
 * Each call spawns one fresh `core` binary against a temporary Workspace on an
 * OS-assigned ephemeral port (`INKSTONE_PORT=0`), serving the built Web Client
 * from `apps/web/dist` (`INKSTONE_WEB_DIR`), with the Worker replaced by the
 * deterministic slow-worker gate fixture so a Run can be paused mid-stream
 * without wall-clock sleeps. Core is the only thing that spawns the Worker
 * (ADR-0001/0013); the harness only points it at the fixture via env.
 */

// <repo>/tests/e2e/src/spawnCore.ts → repo root is three levels up.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

export const CORE_BIN = path.join(REPO_ROOT, "target", "debug", "core");
export const WEB_DIST = path.join(REPO_ROOT, "apps", "web", "dist");
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

/**
 * The provider-login helper command Core runs for `provider/login_start`:
 * the offline stub that emits an authorize URL then credentials (ADR-0019 /
 * ADR-0023). Use via `coreOptions.providerLoginCmd` so the Connect e2e never
 * touches the real OpenAI flow.
 */
export const LOGIN_HELPER_CMD = `${TSX_BIN} ${LOGIN_HELPER_FIXTURE} login`;

const FAUX_WORKER_TS = path.join(
	REPO_ROOT,
	"packages",
	"worker",
	"src",
	"faux-worker.ts",
);

/**
 * The TEST-ONLY faux interpreter worker command
 * (packages/worker/src/faux-worker.ts), as opposed to the slow-worker echo
 * fixture. It drives the REAL pi-agent-core loop offline with an env-scripted
 * faux provider; the production entry (`cli.ts`) carries no faux code. Paired
 * with a faux workflow + `fauxResponse`/`fauxError`/`fauxToolCall`/`faux`, use
 * via `coreOptions.workerCmd = FAUX_WORKER_CMD`.
 */
export const FAUX_WORKER_CMD = `${TSX_BIN} ${FAUX_WORKER_TS}`;

export interface SpawnCoreOptions {
	/** Bind port. Default 0 → OS-assigned ephemeral (avoids cross-test collisions). */
	readonly port?: number;
	/** Serve the SPA from this dir. Default the built `apps/web/dist`. */
	readonly webDir?: string;
	/** Worker command. Default the gate fixture; set to undefined to use Core's default. */
	readonly workerCmd?: string;
	/**
	 * Gate-fixture knobs. When `chunks` > 1, `echo: <prompt>` is split into that
	 * many incremental deltas; `gatePath` (if set) makes the fixture pause after
	 * the first chunk until that file exists. A per-Core tempdir gate path is
	 * created automatically when `chunks` > 1 and no path is supplied.
	 */
	readonly chunks?: number;
	readonly gatePath?: string;
	/**
	 * Provider-login helper command Core runs for `provider/login_start`
	 * (ADR-0023). Set by the Connect-ChatGPT e2e to a stub that emits an
	 * authorize URL then credentials, so the flow runs offline (no real
	 * OpenAI / :1455). Maps to `INKSTONE_PROVIDER_LOGIN_CMD`.
	 */
	readonly providerLoginCmd?: string;
	/**
	 * When set, write a faux Workflow (`provider="faux"`) into a per-test
	 * workflows dir and feed the faux provider this canned response via
	 * `INKSTONE_FAUX_RESPONSE`. Combined with `workerCmd =
	 * FAUX_WORKER_CMD`, this drives the real pi-agent-core loop offline
	 * so a browser test can assert a real interpreter completion (not echo).
	 */
	readonly fauxResponse?: string;
	/**
	 * When set, the faux provider FAILS the turn with this message
	 * (`stopReason: "error"`) instead of replying. Combined with `workerCmd =
	 * FAUX_WORKER_CMD`, this produces the same `error` Run Event a real
	 * provider/network failure would — letting a browser test assert the
	 * error surfaces in the UI. Maps to `INKSTONE_FAUX_ERROR`.
	 */
	readonly fauxError?: string;
	/**
	 * When true, write a faux Workflow whose tool allowlist is `["read_thread"]`
	 * and drive the faux provider in tool-call mode (`INKSTONE_FAUX_TOOL_CALL`):
	 * turn 1 calls `read_thread` with a thread id extracted from the user's
	 * prompt, turn 2 echoes the tool result. Paired with `workerCmd =
	 * FAUX_WORKER_CMD` this exercises the full Tool Protocol round-trip
	 * (Worker proxy ↔ Core registry) end-to-end through the browser.
	 */
	readonly fauxToolCall?: boolean;
	/**
	 * Drive a higher-level faux interpreter mode by name (paired with `workerCmd
	 * = FAUX_WORKER_CMD`). Writes a faux Workflow allowlisting the Journal Entry
	 * intake tools and runs the worker in propose mode (`INKSTONE_FAUX_PROPOSE`):
	 * a fresh turn proposes a create Journal Entry, while same-thread
	 * correction/delete prompts first read current-thread Journal Entries before
	 * proposing update/delete. On accept/reject the Run resumes to a short
	 * confirmation, exercising the full park -> decide -> resume loop end-to-end
	 * (ADR-0025).
	 */
	readonly faux?: "propose";
	/** Direct propose-worker fixture knob. Emits params loaded from this JSON file. */
	readonly proposalParamsFile?: string;
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

	const chunks = opts.chunks ?? 1;
	const gatePath =
		opts.gatePath ?? (chunks > 1 ? path.join(workspaceDir, "gate") : undefined);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		INKSTONE_DB_PATH: dbPath,
		INKSTONE_PORT: String(opts.port ?? 0),
		INKSTONE_WEB_DIR: opts.webDir ?? WEB_DIST,
	};

	// Faux mode is fully determined by `opts` below. Strip any inherited
	// INKSTONE_FAUX_* (a prior run, the parent shell) so an ambient value can't
	// leak one test's mode into another.
	for (const key of [
		"INKSTONE_FAUX_RESPONSE",
		"INKSTONE_FAUX_ERROR",
		"INKSTONE_FAUX_TOOL_CALL",
		"INKSTONE_FAUX_PROPOSE",
		"INKSTONE_FAUX_ECHO_HISTORY",
		"INKSTONE_PROPOSE_PARAMS_FILE",
		"INKSTONE_WORKER_TOOL_CALL_LOG",
	]) {
		delete env[key];
	}

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

	// Per-test credential store (isolated tempdir) so provider/status starts
	// disconnected and a login e2e can observe it flip to connected.
	env.INKSTONE_CREDENTIALS_DIR = path.join(workspaceDir, "credentials");
	if (opts.providerLoginCmd !== undefined) {
		env.INKSTONE_PROVIDER_LOGIN_CMD = opts.providerLoginCmd;
	}

	// Faux-interpreter mode: write a provider="faux" Workflow into a per-test
	// workflows dir and feed the canned response to the faux provider. Paired
	// with workerCmd = FAUX_WORKER_CMD this drives the real
	// pi-agent-core loop offline (ADR-0019 faux seam). `fauxError` instead
	// makes the faux provider fail the turn (stopReason error) — the same
	// `error` Run Event a real provider/network failure produces.
	if (
		opts.fauxResponse !== undefined ||
		opts.fauxError !== undefined ||
		opts.fauxToolCall ||
		opts.faux !== undefined
	) {
		const workflowsDir = path.join(workspaceDir, "workflows");
		mkdirSync(workflowsDir, { recursive: true });
		const tools = opts.fauxToolCall
			? '["read_thread"]'
			: opts.faux === "propose"
				? '["read_thread","read_current_thread_journal_entries","propose_workspace_mutation"]'
				: "[]";
		writeFileSync(
			path.join(workflowsDir, "default.toml"),
			[
				'name = "default"',
				'version = "1.0.0"',
				'provider = "faux"',
				'model = "faux-1"',
				// Deliberately NO `thinking_level` — mirrors the real
				// crates/core/workflows/default.toml, which omits it and relies
				// on settings resolution (DEFAULT_EFFORT = "off"). This exercises
				// the resume path's `resolve_effective_workflow` through the real
				// Worker: an unresolved `thinking_level` would serialize as "" and
				// the manifest decode would reject it (regression guard).
				'system_prompt = "You are a test assistant."',
				`tools = ${tools}`,
				"",
			].join("\n"),
		);
		env.INKSTONE_WORKFLOWS_DIR = workflowsDir;
		if (opts.fauxToolCall) {
			env.INKSTONE_FAUX_TOOL_CALL = "1";
		} else if (opts.faux === "propose") {
			env.INKSTONE_FAUX_PROPOSE = "1";
		} else if (opts.fauxError !== undefined) {
			env.INKSTONE_FAUX_ERROR = opts.fauxError;
		} else if (opts.fauxResponse !== undefined) {
			env.INKSTONE_FAUX_RESPONSE = opts.fauxResponse;
		}
	}

	// Own process group (detached) so shutdown can hard-kill any orphaned
	// Worker children along with Core if SIGTERM to Core alone leaves strays.
	const child = spawn(CORE_BIN, [], {
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
		throw err;
	}

	return {
		url,
		workspaceDir,
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
		},
	};
}
