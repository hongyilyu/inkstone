import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Spawn-and-drive primitive for the full-system Test Harness (ADR-0019): fresh Core + built SPA + gate-fixture Worker. */

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

/** Offline provider-login helper Core runs for `provider/login_start` (ADR-0019/0023): emits authorize URL then credentials. */
export const LOGIN_HELPER_CMD = `${TSX_BIN} ${LOGIN_HELPER_FIXTURE} login`;

const FAUX_WORKER_TS = path.join(
	REPO_ROOT,
	"packages",
	"worker",
	"src",
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
	/** Higher-level faux interpreter mode: `propose` (Journal Entry mutations, ADR-0025) or `extract` (Person extraction from an accepted Journal Entry, slice 4). Drives the park -> decide -> resume loop. */
	readonly faux?: "propose" | "extract";
	/** Direct propose-worker fixture knob. Emits params loaded from this JSON file. */
	readonly proposalParamsFile?: string;
	/** Faux extraction scenario (`INKSTONE_FAUX_EXTRACT_PARAMS`): `{ journal_text, person_name }` JSON file the extract mode reads. */
	readonly extractParamsFile?: string;
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

	// Strip inherited INKSTONE_FAUX_* so an ambient value can't leak one test's mode into another.
	for (const key of [
		"INKSTONE_FAUX_RESPONSE",
		"INKSTONE_FAUX_ERROR",
		"INKSTONE_FAUX_TOOL_CALL",
		"INKSTONE_FAUX_PROPOSE",
		"INKSTONE_FAUX_EXTRACT",
		"INKSTONE_FAUX_EXTRACT_PARAMS",
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

	// Per-test credential store so provider/status starts disconnected and a login e2e can observe it flip to connected.
	env.INKSTONE_CREDENTIALS_DIR = path.join(workspaceDir, "credentials");
	if (opts.providerLoginCmd !== undefined) {
		env.INKSTONE_PROVIDER_LOGIN_CMD = opts.providerLoginCmd;
	}

	// Faux-interpreter mode: write a provider="faux" Workflow and feed the canned response/error/mode to the faux provider (ADR-0019 faux seam).
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
				: opts.faux === "extract"
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
		} else if (opts.faux === "propose") {
			env.INKSTONE_FAUX_PROPOSE = "1";
		} else if (opts.faux === "extract") {
			env.INKSTONE_FAUX_EXTRACT = "1";
			if (opts.extractParamsFile !== undefined) {
				env.INKSTONE_FAUX_EXTRACT_PARAMS = opts.extractParamsFile;
			}
		} else if (opts.fauxError !== undefined) {
			env.INKSTONE_FAUX_ERROR = opts.fauxError;
		} else if (opts.fauxResponse !== undefined) {
			env.INKSTONE_FAUX_RESPONSE = opts.fauxResponse;
		}
	}

	// Own process group (detached) so shutdown can hard-kill orphaned Worker children alongside Core.
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
