# Learned rules — Testing (`testing`)

_34 rules. Loaded by the `dr-testing` specialist. Generated from rules.json — do not edit by hand; run build_kb.py._

## Isolate and restore shared/global state per test  ·  `isolate-and-restore-shared-state`
- **Severity:** important  ·  **Support:** 9  ·  **Seen in:** #133, #134, #27719, #28434, #28529, #29784
- **Rule:** Tests must not leak shared state across tests in the same process. Require save-and-restore (afterEach/afterAll or try/finally) for mutations of process.env, module-level singletons/flags, or event-bus subscriptions, and require persistent state to be written to an isolated temp dir rather than a real/global/home-derived path. A test asserting on a persistent on-disk file must reset/initialize it in setup so results are not order-dependent. Flag a global mutation only when no matching restore captures the prior value.
- **Detect:** Flag: assignments to process.env.* / Flag.* / shared singletons without a matching restore that captures the prior value; mkdir/write into a global path constant instead of a per-test tmpdir; a subscribe/addListener/on call whose unsubscribe return value is discarded; a test asserting on a persistent file's contents with no rm/clear/init of that file before the exercise phase. Ask: is every global mutation undone before the next test runs?

## Cover every new branch — including the contrasting/negative case  ·  `test-new-branch-and-both-sides`
- **Severity:** important  ·  **Support:** 8  ·  **Seen in:** #25773, #25797, #26752, #26754, #26825, #27016
- **Rule:** When a diff adds a new code path (catch/fallback branch, new conditional, new validation that rejects some inputs, or a switch to manual request/body parsing), require a test in the same PR that feeds an input which actually triggers that specific path and asserts the intended outcome. If the new logic also changes classification for an adjacent input class, also require the contrasting case (e.g. accepted AND rejected input). Only flag when the branch carries observable behavior; do not demand tests for trivial logging-only or defensive-unreachable branches.
- **Detect:** For each added catch/else/if branch, distinct log message, new validation, or switch to manual body parsing in src, grep the PR's test files for an input that exercises that branch. Ask per hunk: does any test trigger this exact branch, and is the opposite/adjacent branch also covered? Flag new branches with no corresponding test input.

## Make platform-specific logic and tests reachable on CI; skip honestly  ·  `no-platform-gated-tests-vacuous-on-ci`
- **Severity:** important  ·  **Support:** 7  ·  **Seen in:** #1551, #1723, #3241, #3244, #3620, #4750
- **Rule:** Make platform checks injectable (an optional platform arg defaulting to process.platform) or extract a pure helper so OS-specific logic can be unit-tested on the single-OS CI runner. Gate platform-specific tests with describe.skipIf/it.skipIf so they report as skipped, rather than early-returning inside the test body (which falsely shows green) or asserting that a platform-gated command was not called when it would never run on the runner anyway (mock os.platform() so the branch is reachable). Add tests stubbing any new runtime/environment detection branch.
- **Detect:** A function early-returning on if (process.platform !== "win32") return whose tests assert win32-only behavior; if (process.platform !== "win32") return; at the top of an it/test body; expect(...not called...) on a platform-gated command (pbcopy/clip/xclip/wl-copy) with no os.platform() mock; or a new if (isBunRuntime)/detectInstallMethod() branch with no test stubbing it.

## Regression test must fail on the pre-fix code and exercise the real implementation  ·  `regression-test-must-fail-without-fix`
- **Severity:** important  ·  **Support:** 6  ·  **Seen in:** #131, #21559, #26751, #27545, #27632, #29208
- **Rule:** A test labeled bug-fix/regression/dedup-guard must assert the specific changed behavior so it would FAIL against the pre-fix code. Reject tests that (a) only assert state that already held before the fix, (b) reimplement or copy the production algorithm in the test instead of calling the real entry point, or (c) call the underlying helper in isolation when the fix is in the wiring/component, so removing the production wiring would still pass. Apply only when the PR is explicitly framed as a fix/regression test.
- **Detect:** Ask per regression test: would this assertion also pass on the pre-fix code? Flag test files with comments like 'replicate'/'mirror the logic in <prod file>' or that copy sorting/walking logic from the module under test. Grep the test for the production helper name and check the connecting component/prop/JSX is actually instantiated rather than the helper being called in isolation.

## Cover newly added branchy functions, config/precedence, and observable fields with tests  ·  `tests-must-cover-new-branchy-functions-and-config-precedence`
- **Severity:** important  ·  **Support:** 6  ·  **Seen in:** #120, #125, #154, #3963, #4112, #32282
- **Rule:** When a PR introduces a new exported function with multiple branches/edge cases, a new CLI flag, an env-var path-resolution precedence chain, defensive normalization of malformed external input, or new entries in source-of-truth Record maps (default-model, display-name, env-var, provider-classification), add unit tests exercising each branch/precedence/edge case and asserting the new keys — especially when a sibling test file already exists. Tests should assert the unit's own logic, not standard-library guarantees.
- **Detect:** A diff adds an export function with >2 conditional branches, a parseArgs()/getAgentDir() env-var branch, input-sanitization branches, or keys to maps like defaultModelPerProvider/BUILT_IN_PROVIDER_DISPLAY_NAMES/getApiKeyEnvVars, but touches no corresponding *.test.ts; or a test whose assertions only check a builtin (String.prototype.startsWith) with hardcoded inputs.

## Assert precise, input-tied values — not vacuous or loose matchers  ·  `assert-precise-behavior-tied-values`
- **Severity:** important  ·  **Support:** 5  ·  **Seen in:** #134, #25797, #28432, #29208, #31357
- **Rule:** Assertions must be causally tied to the test input so a default-returning or input-ignoring implementation would fail. Reject as the sole/primary check in a behavior-named test: toBeDefined/toBeTruthy/not.toThrow, or loose negative matchers (not.toBe(true)) that also pass for undefined/1/'false'. Prefer asserting the exact expected value, that valid input fields are preserved and invalid ones absent, or the precise resulting schema/field shape. Do not flag these matchers when the test legitimately only checks existence/non-throwing (e.g. smoke or type-guard tests).
- **Detect:** Flag expect(x).toBeDefined()/.toBeTruthy()/.not.toThrow() or expect(x).not.toBe(true|false) as the sole assertion in a behavior-named test. Ask: would this still pass if the function ignored its input and returned a default? For schema-transform diffs, check a test asserts that exact field's resulting shape. Flag toBe/toEqual against a string literal encoding internal naming conventions.

## Mocks and fixtures must reproduce the semantics under test  ·  `mocks-and-fixtures-must-be-faithful`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #27632, #29208, #30574
- **Rule:** Test doubles and fixtures must distinguish the correct behavior from the buggy one. A mock must reproduce the semantics the assertion depends on (e.g. insert-at-cursor tracks an offset, not append). A fixture for an 'invalid input' test must be genuinely rejected by the actual parser (lenient JSONC/JSON5 accepts comments/trailing commas, so use an unterminated string/missing brace). A fetch/request stub's unmatched branch should fail fast (throw with the unexpected URL) rather than silently return undefined.
- **Detect:** Inspect mock method bodies: does insert/splice just concatenate (text = text + x) instead of honoring a cursor/index? For a test named 'invalid X', would the target parser actually reject the fixture? Flag fetch/request mocks with an implicit fall-through returning undefined when no case matches.

## Synchronize on deterministic signals, not fixed sleeps or silently-resolving timeouts  ·  `deterministic-waits-not-sleeps`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #135, #29635, #29784
- **Rule:** Do not synchronize tests with async work via fixed-delay sleeps (Bun.sleep/setTimeout); await a promise that resolves on the first matching event with a generous timeout, and remove sleeps placed before the operation that triggers the event. When using Promise.race with a timeout branch, the timeout branch must reject with a descriptive error (including the awaited pattern), never resolve to a value/void that would mask a missed event.
- **Detect:** Flag Bun.sleep(N)/setTimeout used to await async events in tests, especially a sleep before the triggering operation. Flag Promise.race([<event>, sleep(ms)]) where the sleep branch resolves to a value/void instead of rejecting with context.

## Polling-wait helpers in tests must be bounded with a timeout and descriptive failure  ·  `bounded-poll-loops-in-tests-must-have-timeout`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #2, #106, #120
- **Rule:** Polling/spawn-wait helpers in tests (waitForGate, waitForFile, retry-until loops, blocking read with a deadline) must enforce a real bound and throw a descriptive error when the deadline passes. An unbounded `while (!existsSync(path)) await sleep(10)`, or a deadline checked only before a blocking read_line/recv() that never returns, hangs CI with no signal instead of failing fast. The wait the timeout guards must itself be interruptible (async read with tokio::time::timeout, read_timeout, select! with a timer, Promise.race).
- **Detect:** Test/fixture `while (` loops with existsSync/await sleep and no Date.now() deadline/timeout/Promise.race; or a Rust `Instant::now() + timeout` deadline whose loop body contains a blocking reader.read_line(...)/recv()/wait() with no per-read timeout. Ask: if the awaited output never comes but the process stays alive, can the deadline ever fire?

## Keep CI coverage portable: don't silently shrink per-platform, and guard OS-specific tests  ·  `no-per-platform-coverage-shrink-guard-platform-tests`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #25375, #29641
- **Rule:** In CI config, do not silently reduce a platform's test command to a narrower scope than before (e.g. one package instead of the workspace suite); any per-platform skip must be explicitly justified. In test files, OS-specific assertions (Windows path casing/backslash normalization) must be guarded with a platform check or .skipIf so the suite stays portable. Flag CI conditionals on RUNNER_OS/platform that run a smaller command than the prior version, and platform-specific assertions lacking a process.platform guard.
- **Detect:** In CI workflow diffs, flag conditionals branching on RUNNER_OS/platform that run a smaller test command than before. In test files, flag OS-specific assertions not wrapped in a platform guard/.skipIf; check for a process.platform check near the assertions.

## Never hardcode workstation-specific absolute paths for test artifacts  ·  `no-hardcoded-workstation-absolute-paths-in-tests`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #83, #86
- **Rule:** Never hardcode an absolute user/home path (/Users/<name>/..., /home/<name>/, C:\\Users\\) for test artifact/screenshot output. Derive the path from the repo root, the test runner's output API (Playwright testInfo.outputPath), or an env var, and create the directory, so the test runs anywhere instead of failing on write in CI or other checkouts.
- **Detect:** Grep test/source lines for string literals beginning with /Users/, /home/, or C:\\ used as a screenshot/artifact/output path. Any hardcoded user-home absolute path in test code = flag.

## Assert the actual persisted/derived value, not just that a transition occurred or a weak shape  ·  `assert-edited-or-derived-value-not-just-transition`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #112, #131
- **Rule:** Tests must assert the concrete persisted/derived value, not merely a state transition or a loose structural property. An edit test must re-query/assert the new value after accept (not just that the card reached accepted and the run resumed). A derived-timestamp test must compute the expected target relative to now and assert equality (not just weekday==Sunday at a fixed time), so off-by-one/off-by-period and edit-application regressions cannot pass silently.
- **Detect:** An edit e2e test asserts only accept/resume wording with no assertion on the new value; or a derived-timestamp test checks only weekday/time suffix with no comparison to now. Ask: would the assertion still pass if the value were one period off or the edit were never applied?

## Wait for the write to land before reloading in a persistence e2e test  ·  `wait-for-write-confirmation-before-reload-in-persistence-e2e`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #74, #136
- **Rule:** An e2e test that reloads to prove persistence must wait for the write to actually land (network response, settled indicator, deterministic saved signal) before page.reload(), not just for the optimistic UI to update. Reloading right after an optimistic state change races the in-flight network/DB write, can tear down the page mid-write, and makes the persistence assertion flaky.
- **Detect:** A Playwright page.reload() immediately follows assertions on optimistic UI (aria-checked, a toggling label) for a value backed by an async save, with no preceding waitForResponse/save-confirmation. Flag the race.

## New providers need an e2e test following the shared per-capability pattern  ·  `new-provider-needs-e2e-test-following-shared-capability-pattern`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #494, #3887
- **Rule:** A new provider/integration implementation should include an end-to-end test that follows the repo's established per-capability pattern used by sibling integrations (shared capability helpers invoked from one describe block per provider against a known-good target), and must mirror the capabilities the sibling suites test — including a reasoning/thinking test when the model under test reports reasoning support. Flag a new providers/ implementation with no corresponding e2e describe using the shared helpers.
- **Detect:** A new provider implementation file under providers/ with no corresponding e2e describe block using the shared capability helpers, or a new describe for a reasoning:true model with no handleThinking/reasoning test while sibling suites have one.

## Keep tests hermetic — extract pure logic instead of spawning external processes  ·  `hermetic-no-external-processes`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #28369
- **Rule:** Avoid unit tests that transitively spawn native/external processes (clipboard utilities like wl-copy/xclip/powershell/clipboardy, arbitrary shell tools) or hit real network/filesystem against external tools, since they are environment-dependent and flake or hang in CI. Extract the pure logic and test it directly, or stub the native boundary so no external process is spawned. Does not apply to tests explicitly designated as integration/e2e.
- **Detect:** In test files, look for calls that transitively spawn child processes (spawn/exec of clipboard or shell utilities) or perform real network/filesystem I/O against external tools; ask whether a pure helper could be tested instead.

## Write tests with the project's test runner, not a hand-rolled script  ·  `use-framework-not-handrolled-script`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #27053
- **Rule:** A file under test/ or named *.test.* must use the repo's test runner (describe/test/it/expect from bun:test, vitest, or jest) rather than a standalone script with manual pass/fail counters and process.exit(). Flag when such a file defines its own assert/counters or calls process.exit() instead of importing a test framework.
- **Detect:** In a file under test/ or named *.test.ts, check it imports from a test framework and uses describe/test/it. Flag if it instead defines its own assert function, increments pass/fail counters, or calls process.exit().

## Invalid-mutation tests must assert proposal/tool status rolled back to pending  ·  `assert-pending-status-rollback-on-failed-mutation`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #129
- **Rule:** For invalid/rejected mutation tests where apply flips the proposal/tool status before validating the failing condition, also assert proposal_status == 'pending' and tool_status == 'pending' (not just 'entity unchanged'/revision count), so a rollback bug that leaves the proposal undecidable is caught rather than passing silently.
- **Detect:** Rust integration tests of apply/decide failure paths assert only 'entity unchanged'/revision count. Check they also cover proposal_status/tool_status == "pending" matching the other invalid-update cases. Flag missing pending-status rollback assertions.

## Production-entry denylist guards must forbid the import wiring and helper symbols, not just keywords  ·  `denylist-guard-must-block-import-path-and-helper-symbols`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #109
- **Rule:** A token-denylist guard against test-only code in the production entry must also forbid the test-only module import path and any exported helper symbols, not just a few keywords. Otherwise a direct import of the faux/test module (using none of the banned tokens) slips through. Add an explicit import-pattern assertion and include helper symbols in the banned list.
- **Detect:** A guard test asserts a file contains no banned tokens but does not assert the file does not import the forbidden module (e.g. .not.toMatch(/import .* from ['"]\.\/faux-worker/)). Flag denylist guards omitting import-path and helper-symbol checks.

## Build before vite preview in e2e/smoke webServer setup  ·  `build-before-vite-preview-in-e2e`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #19
- **Rule:** Vite `preview` serves the dist/ build output, not source — so any e2e/smoke webServer that runs `vite preview` (or `pnpm preview`) must build first (chain `vite build`/`pnpm build` in the script or webServer command). Otherwise tests fail on a clean checkout when dist is missing, or silently pass against a stale artifact. Detection: in playwright/test config or CI, webServer.command or test:e2e invokes preview with no preceding build step.
- **Detect:** In playwright/test config or CI, webServer.command or test:e2e invokes `vite preview`/`pnpm preview` with no preceding `vite build`/`pnpm build`. Flag missing build-before-preview.

## Regression tests must assert the specific named invariant, not a generic precondition  ·  `regression-test-must-assert-the-named-invariant-and-out-of-order`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #4204
- **Rule:** A regression test must assert the specific behavior it is named for and would fail if the original bug were reintroduced: if the bug was 'scrollback wiped', assert scrollback content survives or that the clear-scrollback escape (\x1b[3J) was not emitted, not merely that a redraw occurred. When narrowing a previously-unconditional state reset to one branch of a new mode switch, re-examine every former path so other modes do not strand stale state.
- **Detect:** A test whose name/comment describes a specific invariant but whose assertions only re-assert a precondition or a generic outcome (a full redraw happened); or a diff changing if (clear) into if (clear==="x") where a side-effecting reset (this.maxLinesRendered=...) now runs for fewer branches than before.

## Restore stubbed globals after a test  ·  `restore-stubbed-globals-in-tests`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #5162
- **Rule:** Restore globals stubbed in a test (vi.stubGlobal("WebSocket", ...) or direct globalThis.X = ...) via vi.unstubAllGlobals()/vi.unstubGlobal in afterEach or a try/finally, so the stub does not leak into later tests in the same process and cause cross-test interference.
- **Detect:** A vi.stubGlobal( or direct globalThis.X = assignment in a test with no matching unstub/restore in afterEach or finally.

## Test stateful wrapped spans at narrow width per line segment  ·  `test-stateful-wrapped-span-per-line-segment`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #3102
- **Rule:** When testing rendering of stateful spans that can wrap (OSC 8 hyperlinks), add a narrow-width regression test asserting each wrapped line segment remains correctly styled/hyperlinked, not just that the open/close sequence appears once in the joined output. The renderer/wrapper must preserve and replay such non-SGR escape state across line breaks (or apply open/close around each post-wrap segment).
- **Detect:** Tests for wrapped terminal output whose assertions only inspect lines.join(...) for a single occurrence of an escape sequence; or a wrapper that tracks only SGR (\x1b[...m) state while wrapping text containing OSC 8 (\x1b]8;;).

## Use rounded/tolerant comparisons for sub-pixel geometry in tests  ·  `tolerant-comparison-for-subpixel-geometry-in-tests`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #32169
- **Rule:** In tests, don't assert exact equality (toBe/toEqual) on values that come from runtime layout measurement — getBoundingClientRect(), offsetWidth/Height/Top/Left, clientRect, scroll metrics — because they carry sub-pixel/devicePixelRatio rounding that differs across environments (e.g. -7.9999 vs -8). Round (Math.round) or use a tolerant matcher (toBeCloseTo) before comparing. This applies ONLY to measured rendering geometry; values computed deterministically in code must still use exact assertions (do not weaken those — see assert-precise-behavior-tied-values).
- **Detect:** Test asserting toEqual/toBe on raw getBoundingClientRect()/offset/clientRect float values, or exact integer expectations for measured pixel positions; flag missing Math.round or tolerant matcher.

## Keep test names and labels aligned with what is asserted and with registered identifiers  ·  `test-names-and-labels-match-assertions`
- **Severity:** nit  ·  **Support:** 4  ·  **Seen in:** #117, #132, #25406, #30672, #32284
- **Rule:** A test/describe title must match what it actually verifies; rename when a title claims 'only X' but expectations also cover siblings/descendants. Keep describe/test labels consistent with the identifier actually registered in the implementation (don't label a block 'shell' when the tool is still registered under id 'bash'). Flag only clear mismatches between title scope and asserted scope, or a renamed label diverging from a still-referenced id constant.
- **Detect:** Compare a test's title against its expect() calls: flag 'only X' titles whose expectations cover more than X. Flag renamed describe/test blocks whose new label diverges from the still-registered id constant referenced in the implementation.

## Cover every case the test name claims and every branch the component implements  ·  `cover-every-case-and-branch-named-or-implemented`
- **Severity:** nit  ·  **Support:** 4  ·  **Seen in:** #13, #132, #134, #32261
- **Rule:** Ensure every status/variant named in a test title is actually constructed as a fixture and asserted (if the name says 'completed AND dropped', include a dropped fixture and assert its exclusion). Likewise, cover each branch an interactive component implements — keyboard submit vs newline modifier, whitespace-only rejection, post-action input reset — not just the one happy path. Unnamed/unasserted branches let regressions pass silently.
- **Detect:** Compare the test name's enumerated cases against literals constructed in the body; and cross-reference handler logic (Enter/shiftKey checks, value.trim() guards, setValue("") resets) against the test file. Flag any named case or implemented branch with no fixture/assertion.

## Type-validation rejection tests must reference a real entity of the wrong type  ·  `tests-must-construct-real-wrong-type-fixture-for-type-rejection`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #131, #135
- **Rule:** When testing a type-validation rejection, create a real entity of the WRONG type and reference its id, not a random nonexistent UUID. A random UUID only exercises the missing-entity path and would still pass if the code wrongly accepted an existing entity of the wrong type, giving false confidence about the type-validation contract.
- **Detect:** A rejection test builds an id via Uuid::now_v7()/random and expects an error claiming type validation. Ask: does the test distinguish 'id does not exist' from 'id exists but is the wrong type'?

## Add a mirror decode test when adding a new wire-contract params struct  ·  `add-mirror-decode-test-for-new-wire-params-struct`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #112, #139
- **Rule:** When adding a serde Deserialize-only protocol/params struct, add a mirror decode test that parses the canonical wire JSON into it and asserts field values, matching the existing coverage pattern for sibling *Params types in the mirror_tests module. A wire-contract struct with no decode test can silently drift from the canonical JSON.
- **Detect:** A diff adds `#[derive(..., Deserialize)] pub struct XParams`; check the protocol's mirror_tests module for a test decoding canonical JSON into it (serde_json::from_str(r#"{...}"#) -> XParams). Missing test for a new *Params struct = flag.

## Faithful stdout interception and temp-dir cleanup in tests  ·  `test-must-delegate-stdout-write-and-clean-temp-dirs`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #3620, #4732
- **Rule:** When intercepting process.stdout.write in a test, wrap and forward to the original write (returning its boolean) rather than swallowing output and hardcoding return true, which breaks the runner's own output and diverges from write semantics. Use mkdtemp/mkdtempSync for unique temp dirs and remove them in an afterEach via rmSync(dir,{recursive:true,force:true}); avoid Date.now()-named dirs with no teardown.
- **Detect:** process.stdout.write = ((...) => { ...; return true; }) that does not call the saved original; or mkdirSync(join(tmpdir(), `...${Date.now()}`)) with no matching afterEach/rmSync cleanup.

## For render/transform pipelines, assert the output reconstitutes the input verbatim  ·  `assert-output-reconstructs-input`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #21559
- **Rule:** When testing a rendering/transform pipeline, assert that the reassembled visible output equals the original input verbatim (e.g. lines.join('') === input), not only derived metadata like ids or line counts, so silent character drops/alterations are caught. Flag a render/transform test case that asserts only structure/metadata while sibling cases in the same file include the verbatim-reconstruction check.
- **Detect:** In a render/transform test, flag a hunk that asserts structure/metadata (length, id consistency) but omits a join/concat === input comparison that sibling cases include.

## Assert presence/absence of a JSON key by parsing, not substring containment  ·  `assert-json-structure-not-serialized-substring`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #131
- **Rule:** Assert on parsed JSON structure (parse, then .get("key").is_none()/.is_some()) rather than substring containment of the serialized blob (!data.contains("key")). Substring checks give false negatives on unrelated user content and don't verify document shape.
- **Detect:** A test uses !data.contains("some_field") or data.contains("...") on a serialized JSON String. Ask: is this checking presence/absence of a JSON key via raw string matching instead of parsing?

## Derive test expectations from the shared fixture/source, not hardcoded literal copies  ·  `derive-test-expectations-from-shared-fixture-source`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #13
- **Rule:** Derive test expectations from the same fixture/source the component reads (import currentRun and build the matcher from currentRun.model / currentRun.tokens.toLocaleString()) rather than retyping literal values (/gemma-3 27b/i, /4,812/). Hardcoded copies break on fixture changes even when behavior is correct, and can pass when behavior diverges from the source.
- **Detect:** Assertions matching string/number literals (regex or getByText) that duplicate values present in an imported mock/fixture module. Ask: is this literal a copy of a value the component reads from a module the test could import instead?

## Extract test helpers duplicated across files into the shared common module  ·  `extract-duplicated-test-helpers-into-shared-common-module`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #123
- **Rule:** When the same test helper (migrated_pool, seed_thread, rpc, open_readonly_pool, polling helpers) is defined identically in two or more test files that already import a shared common/test-util module, extract it into that module to avoid divergence and maintenance burden.
- **Detect:** A diff adding a test file defines helper fns (async fn migrated_pool, fn seed_thread, fn rpc) that already exist verbatim in sibling test files / the imported mod common. Ask: is this helper a duplicate of one in another test file?

## Negative/rejection-path tests must assert neutral or path-specific text, not success wording  ·  `negative-path-tests-must-not-assert-success-wording`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #117
- **Rule:** A dismiss/reject/cancel test must assert neutral or reject-specific completion text, never the success-path wording (e.g. /done.*added it/i) used by the accept test. Reusing acceptance wording in a negative-path test means it would still pass if resume messaging incorrectly implied acceptance.
- **Detect:** In a test labeled dismiss/reject/cancel, check any waitForAssistantText/toContainText regex does not match the same acceptance phrase used in the accept test. Flag shared success-wording assertions across opposite-outcome tests.

## Strip the whole env-var prefix family when isolating test behavior  ·  `strip-entire-env-var-prefix-family-in-test-isolation`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #117
- **Rule:** When stripping a known prefix-family of env vars to isolate test behavior, include every variable in the family (or strip by prefix), not a hardcoded list that can omit a newly-added member. A missing key lets a parent-process value leak one test's mode into another.
- **Detect:** A literal array of env var names being deleted (delete env[key] over ["INKSTONE_FAUX_RESPONSE", ...]). Cross-check all same-prefix vars referenced elsewhere; flag any prefix member missing from the cleanup list.
