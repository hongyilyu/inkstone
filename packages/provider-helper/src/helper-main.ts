import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ProviderHelperLine } from "@inkstone/protocol";

// Provider Helper logic behind an injected deps seam (mirrors the Worker's
// runWorkerMain): the entry (provider.ts) passes the real pi OAuth functions;
// tests pass fakes. Every stdout line is typed against the contract-gated
// ProviderHelperLine union — see docs/design/worker.md (ADR-0023).

/** The OAuth operations the helper drives — pi's codex functions in
 * production, fakes in tests. */
export interface HelperDeps {
	login: (hooks: {
		onAuth: (info: { url: string; instructions?: string }) => void;
		onPrompt: () => Promise<never>;
	}) => Promise<OAuthCredentials>;
	refresh: (refreshToken: string) => Promise<OAuthCredentials>;
}

/** The helper's process boundary: line-framed stdout writes and the one stdin
 * read (refresh mode's input). */
export interface HelperIo {
	emit: (line: ProviderHelperLine) => void;
	readFirstLine: () => Promise<string | null>;
}

/** The providers this helper can actually serve. Hand-mirrored by Core's
 * `HELPER_SUPPORTED_PROVIDERS` (crates/core/src/providers.rs), whose registry
 * coherence test keeps `login_allowed` entries inside this set. */
export const SUPPORTED_PROVIDERS: readonly string[] = ["openai-codex"];

/** Map pi's OAuthCredentials (camelCase accountId) to Core's wire shape. */
export function toCoreCredentials(
	creds: OAuthCredentials,
): Extract<ProviderHelperLine, { kind: "credentials" }> {
	const accountId = typeof creds.accountId === "string" ? creds.accountId : "";
	return {
		kind: "credentials",
		access: creds.access,
		refresh: creds.refresh,
		expires: creds.expires,
		account_id: accountId,
	};
}

async function runRefresh(deps: HelperDeps, io: HelperIo): Promise<number> {
	const line = await io.readFirstLine();
	if (line === null) {
		io.emit({ kind: "error", message: "refresh: no input on stdin" });
		return 1;
	}
	const { refresh } = JSON.parse(line) as { refresh: string };
	try {
		const rotated = await deps.refresh(refresh);
		io.emit(toCoreCredentials(rotated));
		return 0;
	} catch {
		// Never forward the SDK error verbatim — it could embed the refresh token.
		io.emit({ kind: "error", message: "refresh failed" });
		return 1;
	}
}

async function runLogin(deps: HelperDeps, io: HelperIo): Promise<number> {
	// pi runs the :1455 loopback and hands us the authorize URL via onAuth; Core relays it to the Web Client.
	const creds = await deps.login({
		onAuth: (info) => io.emit({ kind: "authorize_url", url: info.url }),
		// No interactive prompt in the new-tab flow; reject — the loopback path is the supported one.
		onPrompt: async () => {
			throw new Error(
				"interactive prompt not supported in the new-tab login flow",
			);
		},
	});
	io.emit(toCoreCredentials(creds));
	return 0;
}

/** Dispatch `<mode> <provider>` argv, returning the process exit code. An
 * unknown mode or a provider outside {@link SUPPORTED_PROVIDERS} emits one
 * `error` line and never touches the OAuth deps. */
export async function runHelperMain(
	argv: readonly string[],
	deps: HelperDeps,
	io: HelperIo,
): Promise<number> {
	const mode = argv[0];
	const provider = argv[1];
	if (mode !== "refresh" && mode !== "login") {
		io.emit({
			kind: "error",
			message: `unknown provider-helper mode: ${mode ?? "<none>"}`,
		});
		return 1;
	}
	// The registry flag (login_allowed) alone must not be able to route a
	// provider here that this helper cannot serve — reject before any OAuth call.
	if (provider === undefined || !SUPPORTED_PROVIDERS.includes(provider)) {
		io.emit({
			kind: "error",
			message: `unsupported provider: ${provider ?? "<none>"}`,
		});
		return 1;
	}
	try {
		return mode === "refresh"
			? await runRefresh(deps, io)
			: await runLogin(deps, io);
	} catch {
		// Never forward the thrown error verbatim — it could embed the refresh token.
		io.emit({ kind: "error", message: "provider helper failed" });
		return 1;
	}
}
