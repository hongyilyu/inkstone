// Provider-login helper STUB for slice-8 tests. Stands in for
// `packages/worker/src/provider.ts login` via INKSTONE_PROVIDER_LOGIN_CMD so
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
	emit({
		kind: "authorize_url",
		url: "https://auth.openai.com/oauth/authorize?stub=1",
	});
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
