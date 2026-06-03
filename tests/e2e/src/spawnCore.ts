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

const INTERPRETER_CLI = path.join(
	REPO_ROOT,
	"packages",
	"worker",
	"src",
	"cli.ts",
);

/**
 * The REAL generic interpreter worker command (packages/worker/src/cli.ts),
 * as opposed to the slow-worker echo fixture. Paired with a faux workflow +
 * `fauxResponse`, it drives the real pi-agent-core loop offline through the
 * browser. Use via `coreOptions.workerCmd = INTERPRETER_WORKER_CMD`.
 */
export const INTERPRETER_WORKER_CMD = `${TSX_BIN} ${INTERPRETER_CLI}`;

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
	 * INTERPRETER_WORKER_CMD`, this drives the real pi-agent-core loop offline
	 * so a browser test can assert a real interpreter completion (not echo).
	 */
	readonly fauxResponse?: string;
	/**
	 * When set, the faux provider FAILS the turn with this message
	 * (`stopReason: "error"`) instead of replying. Combined with `workerCmd =
	 * INTERPRETER_WORKER_CMD`, this produces the same `error` Run Event a real
	 * provider/network failure would — letting a browser test assert the
	 * error surfaces in the UI. Maps to `INKSTONE_FAUX_ERROR`.
	 */
	readonly fauxError?: string;
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
			reject(new Error(`Core did not announce INKSTONE_LISTENING within ${timeoutMs}ms`));
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

	const workerCmd =
		opts.workerCmd !== undefined ? opts.workerCmd : GATE_WORKER_CMD;
	if (workerCmd) {
		env.INKSTONE_WORKER_CMD = workerCmd;
		env.INKSTONE_FIXTURE_CHUNKS = String(chunks);
		if (gatePath) env.INKSTONE_FIXTURE_GATE = gatePath;
	}

	// Per-test credential store (isolated tempdir) so provider/status starts
	// disconnected and a login e2e can observe it flip to connected.
	env.INKSTONE_CREDENTIALS_DIR = path.join(workspaceDir, "credentials");
	if (opts.providerLoginCmd !== undefined) {
		env.INKSTONE_PROVIDER_LOGIN_CMD = opts.providerLoginCmd;
	}

	// Faux-interpreter mode: write a provider="faux" Workflow into a per-test
	// workflows dir and feed the canned response to the faux provider. Paired
	// with workerCmd = INTERPRETER_WORKER_CMD this drives the real
	// pi-agent-core loop offline (ADR-0019 faux seam). `fauxError` instead
	// makes the faux provider fail the turn (stopReason error) — the same
	// `error` Run Event a real provider/network failure produces.
	if (opts.fauxResponse !== undefined || opts.fauxError !== undefined) {
		const workflowsDir = path.join(workspaceDir, "workflows");
		mkdirSync(workflowsDir, { recursive: true });
		writeFileSync(
			path.join(workflowsDir, "default.toml"),
			[
				'name = "default"',
				'version = "1.0.0"',
				'provider = "faux"',
				'model = "faux-1"',
				'thinking_level = "off"',
				'system_prompt = "You are a test assistant."',
				"tools = []",
				"",
			].join("\n"),
		);
		env.INKSTONE_WORKFLOWS_DIR = workflowsDir;
		if (opts.fauxError !== undefined) {
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
