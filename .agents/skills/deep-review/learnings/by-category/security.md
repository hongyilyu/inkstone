# Learned rules — Security (`security`)

_18 rules. Loaded by the `dr-security` specialist. Generated from rules.json — do not edit by hand; run build_kb.py._

## Validate and normalize untrusted paths (and use literal pathspecs) before passing them to file/VCS APIs  ·  `validate-untrusted-path-before-file-api`
- **Severity:** blocking  ·  **Support:** 4  ·  **Seen in:** #2037, #25403, #30722
- **Rule:** Before passing a user/markdown/URL-derived path to a file-read API or to git, reject path-traversal: decode percent-encoded sequences (e.g. %2e%2e) then reject `..` segments, absolute paths, and drive/protocol prefixes ([A-Za-z]:, \\). For git, pass dynamic paths as literal pathspecs (:(literal) or --pathspec-file-nul) on every call site, including batched ones. Never rely on client-side checks alone; ensure server-side sandboxing too.
- **Detect:** Find file/path read calls (client.file.read, fs read) or git invocations after `--` whose argument originates from user/markdown/URL input. Yes/no: is there a guard rejecting `..`, leading `/`/`\`, drive prefixes, AND percent-encoded traversal before the call? For git, is each path wrapped as a literal pathspec on both single and batched call sites?

## Enforce filesystem boundary/containment checks against the resolved realpath, not the requested path  ·  `resolve-realpath-before-boundary-check`
- **Severity:** blocking  ·  **Support:** 3  ·  **Seen in:** #26262, #26958, #32263
- **Rule:** When a file operation walks, copies, archives, or boundary-checks a path that may be a symlink, resolve the real path (realpath, or lstat to detect symlinks) and assert it stays under the intended base directory BEFORE including/trusting it. Do not run containment checks on the pre-resolved requested path, and prefer lstatSync over statSync when collecting files for an export/zip/tar so a symlink cannot escape the base dir.
- **Detect:** Yes/no per hunk: does a containment/assertExternal/contains-path check run on a raw requested path instead of the output of resolve/realpath? OR does a file-collection walker use statSync() instead of lstatSync() / a realpath-within-base assertion before adding entries to a zip/tar/archive? Flag if a symlink could escape the base dir.

## Escape HTML attributes and sanitize untrusted text before rendering as markup  ·  `escape-and-sanitize-untrusted-markup`
- **Severity:** blocking  ·  **Support:** 3  ·  **Seen in:** #4541, #27890, #30722
- **Rule:** When building HTML from user/model/markdown-derived values, HTML-escape attribute values (at least & " < >) before interpolating into `="${...}"` (extract a shared escapeAttr helper, URL-encode href). When rendering untrusted text through a Markdown/HTML component, ensure the renderer sanitizes output by disabling raw HTML and unsafe URL schemes (javascript:, data:). Do not interpolate untrusted strings into markup without an escape/sanitize step.
- **Detect:** Grep for backtick template literals building HTML with `="${...}"` where the interpolated value is not passed through an escape/encode helper; OR a Markdown/<Markdown> component fed user/model input. Yes/no: are attribute values escaped and is raw HTML / unsafe URL schemes disabled?

## Default consent/safety gates to the restrictive value and preserve specific guardrails when refactoring  ·  `secure-defaults-and-preserve-guardrails`
- **Severity:** blocking  ·  **Support:** 3  ·  **Seen in:** #4434, #25406, #26821
- **Rule:** Default any permission/auto-accept/auto-approve or consent gate to the most restrictive (opt-in) value; auto-approval of edits or destructive actions must be explicit opt-in. When refactoring or compacting safety rules/prompts, do not fold a specific destructive-action guard (e.g. default-branch force-push protection, deletion protection, secret-file warning) into a weaker generic clause; flag the removal of any specific guardrail relative to the deleted text.
- **Detect:** Flag a default value for a permission/auto-accept setting that is not the most restrictive option (especially where it silently replies to permission requests). Separately, diff rewritten rules/prompt/policy files: list safety clauses removed vs kept and ask whether a specific destructive-action guard was dropped or weakened relative to the deleted text.

## Pin update/delete mutations to the originally-reviewed target, not the edited payload's id  ·  `pin-update-delete-target-to-reviewed-proposal-not-edited-payload`
- **Severity:** blocking  ·  **Support:** 2  ·  **Seen in:** #123
- **Rule:** For update/delete mutations acting on a reviewed target, unconditionally preserve the original proposal's target id (or reject if the edited payload supplies a mismatched/extra target id). Never let an edited payload retarget the operation away from the entity that was actually reviewed. If the original proposal is malformed (missing its required target id), return Invalid/Err rather than falling back to the edited payload, so a malformed proposal is not implicitly retargetable and replay/recovery can recover the accepted id.
- **Detect:** An apply/mutation path derives the update target from edited/user-supplied payload (edited_payload.get("entity_id"), target_entity_id(applied_payload)) instead of the original proposal; or a `let Some(id)=... else { return Ok(edited_payload.clone()) }` fallback for a missing required target id. Ask: can the edited payload's id differ from the reviewed proposal's and still be used as the target?

## Strip control characters from untrusted input before embedding in terminal escape sequences  ·  `sanitize-control-chars-before-terminal-escape-sequences`
- **Severity:** blocking  ·  **Support:** 2  ·  **Seen in:** #112, #3102
- **Rule:** Before interpolating user/untrusted text (parsed markdown hrefs, titles, command output) into a terminal control sequence (OSC 8 hyperlink, SGR), strip or reject non-printable/control characters (\x00-\x1f, \x7f, ESC, BEL, ST). Also strip ANSI sequences from captured subprocess stdout/stderr before rendering it into the TUI.
- **Detect:** Look for template literals building escape sequences like `\x1b]8;;${var}\x07` or `\x1b[...${var}` where var is externally sourced (href, title, stdout), or subprocess stdout concatenated into a TUI text/markdown component without a stripAnsi/control-char filter.

## Verify caller identity/ownership before finalizing or mutating an owned resource  ·  `authorize-state-mutating-operations`
- **Severity:** blocking  ·  **Support:** 1  ·  **Seen in:** #27053
- **Rule:** An operation that finalizes or mutates a resource claimed/owned by a specific actor (complete/finish/done) must require the actor's identity in the input and enforce it (e.g. assignee === sessionID, or restrict to an authorized role). Do not allow any caller holding only the resource ID to mutate someone else's work.
- **Detect:** Compare the inputs of a claim/assign function vs its corresponding complete/finalize function on the same resource: if claim takes a sessionID/userID but complete does not, and the body never checks task.assignee/owner, flag missing authorization.

## Default network servers to loopback unless auth is enforced before non-loopback bind  ·  `server-default-loopback-not-all-interfaces`
- **Severity:** blocking  ·  **Support:** 1  ·  **Seen in:** #4434
- **Rule:** A server exposing actionable endpoints (prompt/exec/agent control) must not default its bind host to 0.0.0.0 while authentication is only enforced when an optional token happens to be set. Default to 127.0.0.1, or require/auto-generate a token before binding to a non-loopback interface. Also bracket IPv6 literals when interpolating host into URLs.
- **Detect:** Grep for default host literals like host:"0.0.0.0" or listen(port,"0.0.0.0") where auth is gated on a possibly-empty token (if (token && ...)); and template URLs http://${host}:${port} where host may be an IPv6 literal and is not bracketed.

## Statement-boundary regex used as a guard must treat newline as a separator  ·  `statement-boundary-regex-must-include-newline-separator`
- **Severity:** blocking  ·  **Support:** 1  ·  **Seen in:** #177
- **Rule:** A regex that anchors a match to a shell/command statement boundary — used to detect or block a command (`git push`, `gh pr create`, `rm`) anywhere in a possibly-multiline payload — must include the newline as a valid statement separator alongside `^ ; & | (`. Omitting `\n` from the boundary character class lets a multiline command bypass detection entirely (the dangerous statement on a fresh line is never matched), defeating a security/policy gate. Include `\n` (and `\r`) in the separator class, and test a multiline input.
- **Detect:** Find a boundary regex like `(?:^|[;&|(])\s*` (or similar) whose character class of statement separators is used to detect a command in user-controlled or multiline text. Ask: does the class include `\n`? If a command can appear after a newline in the payload, a missing `\n` makes the guard bypassable. Confirm with a multiline test fixture.

## Do not log or export raw user content, secret-bearing errors, or identifying paths  ·  `no-sensitive-data-in-logs-or-diagnostics`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #25615, #26262, #29208
- **Rule:** Do not write raw user-supplied content (question/prompt/message bodies), full pretty-printed exceptions/causes whose message can embed parsed secret/config input, or user-identifying details (absolute home/userData paths, env vars) into logs or shareable diagnostic bundles. Log only redacted identifiers/metadata (IDs, error type/name/location) and redact before generating any exportable archive. Treat info/warn-level logging of free-text input fields as the primary flag.
- **Detect:** Flag log/diagnostic calls whose payload includes: raw free-text fields (question/prompt/message/input) at info/warn; a full exception/cause (Cause.pretty, err.message) from a parser fed secret/config content; or absolute home/userData/crashDumps paths or env vars in an object destined for export. Ask: could this leak a secret, message body, or username?

## Validate the OAuth CSRF state parameter before acting on any callback outcome  ·  `validate-oauth-state-first`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #28557, #31700
- **Rule:** In an OAuth/loopback callback handler, validate that a pending authorization exists and that the returned `state` equals the stored state as the FIRST gate for every outcome (error, missing code, and success). Do not reject, resolve, or clear the pending flow on the error/missing-code branch before the state comparison, or any local request to the fixed loopback port can cancel or hijack the authorization without knowing the state.
- **Detect:** In an OAuth redirect handler, check ordering: is the `state` comparison performed after the code branches on `error`/missing `code` and mutates pending state? Yes/no: can any callback outcome reject/resolve/clear pendingOAuth before state is verified?

## Sanitize and validate environment data passed to child processes  ·  `sanitize-data-crossing-subprocess-boundary`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #1723, #25962, #29158
- **Rule:** Do not pass `env: process.env` (or a spread of it) to a spawned subprocess by reference; build a fresh env containing only the values the child needs and ensure all values are strings. Any env-sourced URL/endpoint/proxy forwarded to a child process or fetch must be parsed and scheme/host-validated (e.g. enforce expected scheme, restrict to an allowlist such as loopback) before use.
- **Detect:** Grep for `env: process.env` / `...process.env` in spawn/fork/exec without filtering. Also find env vars holding a URL/endpoint/proxy (process.env / std::env::var / getenv) passed straight to a subprocess or fetch. Yes/no: is the child env a sanitized string-valued copy, and is any env URL parsed + scheme/host-validated before use?

## Exclude SVG from broad image/* render allowlists  ·  `restrict-image-mime-allowlist-exclude-svg`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #30722
- **Rule:** Do not gate rendering/embedding on a broad `mimeType.startsWith("image/")` check, which permits image/svg+xml and its scripting/external-reference risk. Restrict to a safe raster set (png, jpeg, gif, webp, avif) or explicitly exclude svg unless SVG support is required.
- **Detect:** Grep for startsWith("image/") or similar broad MIME prefix checks used to gate rendering/embedding; ask whether svg+xml is unintentionally allowed.

## Bound untrusted base64/payload length before decoding  ·  `bound-untrusted-base64-before-decode`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #120
- **Rule:** Before Buffer.from(untrustedBase64, "base64") or feeding decoded bytes to a parser, enforce a maximum input length and reject oversized payloads up front, so a malicious or huge payload cannot exhaust memory before being measured.
- **Detect:** Buffer.from(<userControlled>, "base64") or decoded request/message bytes passed to a parser (imageSize) with no preceding length/size guard.

## A by-name fetch that resolves to a filesystem path must re-apply the discovery/eligibility filter  ·  `by-name-lookup-must-reapply-listing-eligibility-filter`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #171
- **Rule:** When a resource is both discoverable via a curated listing/scan (which deliberately excludes ineligible entries) and fetchable directly by name (resolving name to a path), the by-name path must re-check that the name is in the eligible scanned set before returning content. Otherwise a guessed/crafted name loads any matching file the listing intentionally skipped, bypassing the disclosure-hardening the listing enforces.
- **Detect:** A resource is reachable two ways: (1) a curated discovery/listing function that filters entries (scan/list/index dropping items for missing/invalid metadata, name mismatch, unsafe content), and (2) a direct by-name/by-id fetch that resolves the identifier to a backing location (e.g. name -> <dir>/<name>/<file>, or id -> row) and returns content. Flag when the by-name path enforces only structural safety (path-containment, single-component, id-format) but does NOT verify the identifier is a member of the eligible discovery result before returning. Ask: if a caller guesses/crafts a valid-but-unlisted name, does this path serve content the listing deliberately excluded? The fix shares the discovery eligibility predicate (e.g. eligible()/load_body) across both paths so loadable set == advertised set.

## Invoke subprocesses with an explicit argument array, not an interpolated shell command string  ·  `prefer-arg-array-over-shell-string-for-subprocess`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #32479
- **Rule:** Building a single command string by interpolating a variable (path, filename, user/FS-derived value) and passing it to a shell-executing API runs through the shell: it is brittle (quoting/escaping) and a command-injection vector. Invoke the executable directly with an args array (execFile/spawn/execFileSync or the project's args-array helper) so arguments are passed verbatim and never shell-interpreted.
- **Detect:** Grep for execSync/exec/`child_process.exec`/`sh -c`/`bash -c`/`powershell -Command "..."` whose sole argument is a template literal that interpolates a variable (e.g. ``execSync(`tool ${x}`)``). Then ask: (1) is the interpolated value FS-, filename-, or otherwise externally derived (paths with spaces/quotes/`$`/`;` are both a quoting bug AND an injection vector)? and (2) would an args-array form (execFile/execFileSync/spawn with `[args]`, or the project's args-array helper) pass it verbatim and avoid the shell entirely? Flag the shell-string form even when it sits next to a sibling that already uses the args-array API (a regression that collapsed an array invocation into a string is the strongest signal).

## Escape untrusted/external values before interpolating them into a CSS selector string  ·  `escape-untrusted-values-interpolated-into-css-selectors`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #187
- **Rule:** When a value you do not fully control (a URL search param, route param, server-supplied id, or any user-influenced string) is interpolated into a CSS selector string passed to querySelector/querySelectorAll/matches/closest, escape it with CSS.escape(value) (or validate it against a strict format). A raw value containing selector metacharacters (", ], \, whitespace, #, .) can break the selector (throwing or mis-parsing) or match unintended elements, turning a focus/scroll/highlight lookup into a no-op or a wrong-target hit. CSS.escape is the standard, allocation-cheap fix; reserve format validation for cases where the id should be a known shape (e.g. a UUID).
- **Detect:** grep for template literals embedded in a selector passed to querySelector/querySelectorAll/closest/matches: /querySelector(All)?\(`[^`]*\$\{/ or an attribute selector like `[data-x="${v}"]`. For each, trace v's origin; if it comes from URL/search params, route params, network/server data, or user input and is NOT wrapped in CSS.escape() or pre-validated to a safe charset, flag it. Plain literals or values already CSS.escape()'d are fine.

## Don't surface internal identifiers into user-facing display text  ·  `no-internal-ids-in-user-facing-text`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #130
- **Rule:** Do not interpolate internal identifiers (ref_id, uuid, *_id) into user-facing preview/review display strings (e.g. `[entity_ref:${record.ref_id}]`). Render a generic placeholder (`[entity_ref]`) instead, which avoids leaking implementation detail and improves readability.
- **Detect:** Template strings interpolating *_id/uuid fields into display/preview text, e.g. `[entity_ref:${...ref_id}]` inside a fn returning text for UI. Flag id leakage into rendered output.
