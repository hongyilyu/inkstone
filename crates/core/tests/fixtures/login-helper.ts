// Provider-login helper STUB for slice-8 tests. Stands in for
// `packages/provider-helper/src/provider.ts login` via INKSTONE_PROVIDER_LOGIN_CMD so
// the Core login-orchestration test runs offline (no real :1455 / OpenAI).
// Node builtins only.
//
// Emits the authorize_url line immediately, then — after a short delay (so
// the test observes the two-phase flow: reply-then-persist) — a Core-shaped
// credentials line. The credential access token is `logged-in-access` so the
// test can assert the persisted/connected outcome.

const emit = (obj: unknown): void => {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
};

async function main(): Promise<void> {
	// Failure injection (Core provider-login error-path test): when
	// INKSTONE_LOGIN_STUB_ERROR is set, emit a sanitized error line BEFORE any
	// authorize_url and exit — mirroring a helper that fails the OAuth flow.
	const errorMessage = process.env.INKSTONE_LOGIN_STUB_ERROR;
	if (errorMessage !== undefined && errorMessage.length > 0) {
		emit({ kind: "error", message: errorMessage });
		return;
	}

	// The authorize URL the stub reports. Defaults to a realistic OpenAI URL
	// (the Core integration test asserts this exact value); the browser e2e
	// overrides it via INKSTONE_LOGIN_STUB_URL=about:blank so window.open in
	// headless Chromium navigates somewhere harmless instead of the real
	// OpenAI auth page.
	const url =
		process.env.INKSTONE_LOGIN_STUB_URL ??
		"https://auth.openai.com/oauth/authorize?stub=1";
	emit({ kind: "authorize_url", url });
	// Simulate the user completing the browser flow + the :1455 callback.
	await new Promise((r) => setTimeout(r, 100));
	emit({
		kind: "credentials",
		access: "logged-in-access",
		refresh: "logged-in-refresh",
		expires: Date.now() + 3_600_000,
		account_id: "acct_login_stub",
	});
}

main().catch(() => {
	emit({ kind: "error", message: "login helper failed" });
	process.exit(1);
});
