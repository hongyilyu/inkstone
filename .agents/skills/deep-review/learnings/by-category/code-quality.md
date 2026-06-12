# Learned rules — Code quality & drift (`code-quality`)

_32 rules. Loaded by the `dr-code-quality` specialist. Generated from rules.json — do not edit by hand; run build_kb.py._

## Verify hardcoded vendor URLs and release package names are current and consistent  ·  `verify-hardcoded-vendor-urls-and-names`
- **Severity:** blocking  ·  **Support:** 3  ·  **Seen in:** #494, #3620, #15513, #25375
- **Rule:** Flag newly added/changed hardcoded third-party URLs (e.g. api.github.com/repos/<org>/<repo>, download endpoints) and release/publish package-name strings; cross-check the name against package.json and other publish scripts, and call out org/repo that may have moved or renamed.
- **Detect:** Flag newly added/changed hardcoded vendor URLs (api.github.com/repos/<org>/<repo>, download endpoints) and check org/repo against current upstream. In release/publish config diffs, extract the package-name string and grep the repo; flag if it does not match package.json or publish scripts.

## No direct console.* in code reachable under an interactive TUI  ·  `console-output-corrupts-tui`
- **Severity:** blocking  ·  **Support:** 2  ·  **Seen in:** #492, #761
- **Rule:** In an app with an interactive terminal renderer (Ink/blessed/raw ANSI), do not call console.log/warn/error in code that can execute while the renderer is active; direct stdout writes corrupt the rendered frame. Route through the app's UI/notify context or a logger that the renderer coordinates with. Flag added console.* in render-path code (components, agent/provider/core loops invoked during a render).
- **Detect:** grep for console.(log|warn|error)( added in diffs under packages/ai/src, packages/agent/src, core, providers/, modes/interactive, tui/, cli/file-processor, or any file reachable while the TUI is rendering.

## Do not overwrite public-facing docs with internal contributor notes  ·  `preserve-public-docs`
- **Severity:** blocking  ·  **Support:** 1  ·  **Seen in:** #25375
- **Rule:** Flag README/doc diffs that delete large blocks of public usage/install/FAQ content unrelated to the PR's stated change, or that switch the document's intended audience or language; such notes belong in CONTRIBUTING/AGENTS.md.
- **Detect:** Flag README/doc diffs that remove large blocks of public usage/install/FAQ content unrelated to the PR's described change, or that switch the document's audience or language.

## Declare new imports in package.json and avoid dep/devDep duplication or floating versions  ·  `package-dependency-declaration-hygiene`
- **Severity:** important  ·  **Support:** 4  ·  **Seen in:** #120, #1694, #2037, #3474
- **Rule:** When a new bare-specifier import is added (not relative, not a node: builtin), confirm the package is declared in the nearest package.json dependencies — a missing dep compiles via monorepo hoisting but breaks at publish/install. List a package in exactly one of dependencies/devDependencies (a runtime package belongs only in dependencies), pin to a compatible semver range aligned with the monorepo version rather than `*`/`@*`, and double-check npm:-alias strings target a real package/version.
- **Detect:** An added `import ... from "<bare-specifier>"` whose package root is absent from package.json deps; a package present in both dependencies and devDependencies; a version value matching `@\*"` or exactly `"*"`; or a `npm:<otherName>@<range>` alias.

## Route new user-facing strings through the i18n translation helper  ·  `route-user-strings-through-i18n`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #23407, #26262, #30543
- **Rule:** In a file that already imports/uses an i18n helper (language.t/useLanguage/i18n), flag new hardcoded English user-facing strings (titles, labels, ariaLabel, placeholders) where sibling values go through the helper. Only apply when the file demonstrably uses i18n already, to avoid flagging projects that intentionally don't translate.
- **Detect:** In a file importing an i18n helper, flag raw English string literals in user-facing JSX text nodes or fields (title/label/ariaLabel/placeholder), especially adjacent to existing `language.t(...)` calls. In i18n dictionary diffs, flag fragments beginning/ending with ' ,' / ' .' or a stray leading space.

## Keep PR scope tight; flag incidental generated-file or core-module drift  ·  `keep-pr-scope-tight-no-incidental-generated-or-core-changes`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #3375, #4005, #4380
- **Rule:** A focused feature PR should not silently carry unrelated changes: regenerating a shared generated/catalogue file (models.generated.ts) that also touches unrelated entries' pricing/contextWindow/maxTokens, or bulk cleanup/refactor of a core module mixed into a feature, must be split out or explicitly called out in the description, since unannounced metadata drift changes cost estimation and truncation behavior for existing users.
- **Detect:** In a PR scoped to feature X, a *.generated.* file also modifies fields of unrelated entries (cost, contextWindow, maxTokens, new unrelated model ids); or a core/shared module gains many edits not needed for the stated feature.

## Set done/resolved markers only after the async work succeeds  ·  `set-done-flag-only-after-success`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #30722
- **Rule:** Flag code that sets a done/resolved marker (flag, attribute, set entry) before awaiting the async operation it represents, with no clear-on-failure path, since a rejection or empty result leaves the item permanently marked done and never retried.
- **Detect:** Find code that sets a done/resolved flag immediately before the await/promise it is supposed to gate. Ask: if the awaited op throws or returns empty, is the flag left incorrectly set with no clear-on-failure path?

## Gate experimental tool/command registration behind the same flag as the feature  ·  `gate-feature-registration-behind-its-flag`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #28610
- **Rule:** When a feature is guarded by an experimental/config flag, flag tool/command/route registration of that capability that is NOT guarded by the same flag, since clients or models could invoke a feature meant to be off.
- **Detect:** When a feature is guarded by `cfg.experimental?.X` (or similar) in one place, check whether its tool/command registration is also guarded by the same flag; flag unconditional registration.

## Audit all call sites when moving a responsibility out of a shared chokepoint  ·  `audit-callsites-when-moving-responsibility`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #19961
- **Rule:** When a shared function stops doing work it used to (prompt/message assembly, normalization) and now trusts callers to pre-build input, flag call sites in the diff that still pass empty/partial values for the field no longer assembled internally.
- **Detect:** When a function stops doing work it used to do and now trusts callers, grep all call sites constructing its input; flag any passing an empty or partial value for the field that is no longer assembled internally.

## Key dismissal/throttle state per distinct action, not one shared flag  ·  `key-dismissal-state-per-action`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #26248
- **Rule:** When a dialog's triggering action is generalized from one case to many, flag a single shared persisted dismissal/throttle key (DONT_SHOW/LAST_SEEN_AT); key it per distinct action so dismissing one occurrence doesn't suppress unrelated ones.
- **Detect:** Flag a shared persisted flag (kv/localStorage key) gating a dialog whose triggering action has been generalized from one case to many; ask whether the key should be per-action.

## Verify the runtime executor actually forwards an advertised/enabled tool  ·  `advertised-tool-must-be-forwarded-by-executor`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #76
- **Rule:** When enabling a tool/capability in config and prompt text, verify the runtime that actually executes (worker/interpreter) is wired to use it. Advertising a tool the executor never passes through (worker still runs with tools: []) produces misleading behavior in production while tests that bypass the executor pass.
- **Detect:** Config/prompt adds a tool to a workflow (tools = [...]) but the worker invocation still passes an empty tools list. Ask: does the production execution path actually forward the advertised tool, or only the test fixture?

## Render replayed result strings from the actual applied payload, not a generic constant  ·  `render-result-from-applied-payload-not-generic-constant`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #117
- **Rule:** When a result string is replayed to a model on resume/recovery, render it from the actual applied/edited payload (include the edited fields like occurred_at/body) rather than returning a fixed generic message that ignores the payload argument. A render fn whose payload parameter is unused (named _payload) discards the committed state the model needs to reconstruct the turn.
- **Detect:** A fn (render_accept/render_result) names its payload/data parameter with a leading underscore (_payload) yet returns a hardcoded string. Flag: is the applied payload actually read into the returned message?

## Don't hand-edit auto-generated files  ·  `do-not-hand-edit-generated-files`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #1847
- **Rule:** Do not hand-edit files that are auto-generated by a build/codegen script (*.generated.ts, headers indicating generation); change the generator or its source data instead, since manual edits are clobbered on the next build and can introduce incorrect entries.
- **Detect:** A diff touching a file named *.generated.* or with a header indicating it is auto-generated.

## Don't hardcode developer-specific absolute paths in tracked scripts  ·  `no-developer-specific-absolute-paths-in-tracked-scripts`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #1694
- **Rule:** Test/debug/service scripts must not hardcode developer-specific absolute paths ($HOME/workspace/..., /home/<user>/..., %h/workspace/..., /Users/<user>/...); derive paths relative to the repo root (git rev-parse --show-toplevel), invoke binaries from PATH, and allow overrides via env vars or arguments so the script is runnable for other contributors and CI.
- **Detect:** Added shell/systemd/config files with absolute paths containing a username or personal dir: /home/[a-z]+/, $HOME/workspace, %h/workspace, /Users/[a-z]+/.

## Use explicit escape sequences for control-character delimiters in source  ·  `explicit-escape-for-control-char-delimiters`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #3241
- **Rule:** Never paste a raw/invisible control character (a literal NUL shown as ^@) into source as a join/separator delimiter; use an explicit escape (\0, \x00) so the separator is readable, greppable, and survives copy/paste and diff tooling, matching the repo's existing convention.
- **Detect:** A .join(...) (or split) delimiter argument containing a non-printable/control byte (often rendered ^@) rather than a visible escape like \0.

## Extract duplicated helpers, lookups, and bootstrap expressions instead of copy-pasting  ·  `extract-duplicated-logic`
- **Severity:** nit  ·  **Support:** 8  ·  **Seen in:** #42, #123, #160, #171, #3851, #25389
- **Rule:** When the same non-trivial logic (identical helper bodies, escape chains, inline types, init/bootstrap wiring) appears in 2+ places within one diff, suggest extracting to a shared helper so copies cannot drift. Only flag substantive logic, not trivial 1-2 line expressions, to avoid premature-abstraction noise.
- **Detect:** Detect the same function name+body, identical inline `type X = {...}`, identical chained `.replace(/&/g,...).replace(/"/g,...)`, or identical multi-call init expression appearing in 2+ files/sites in the same diff. Also: a diff adds config options to one call of a primitive (prompts.spinner, logger) while sibling bare calls remain. Ask: should this be shared from one module?

## Remove dead code, leftover state, no-op steps, and stale placeholder comments  ·  `remove-dead-and-placeholder-code`
- **Severity:** nit  ·  **Support:** 8  ·  **Seen in:** #20, #160, #1221, #2037, #25663, #26092
- **Rule:** Flag dead/placeholder code introduced in a diff: commented-out executable code, scaffolding comments left after real values are wired in, state/cleanup orphaned when its logic was deleted (e.g. timer var + clearTimeout after the setTimeout was removed), and no-op chain steps whose result is never consumed. Emphasize the orphaned-state and unconsumed-result cases, which are real bugs rather than cosmetics.
- **Detect:** Flag: added lines that are commented-out code (`// if (`, `// return`, `// const`); placeholder phrasing ('replace these', 'your actual', 'example only') above lines now referencing real assets; references to a timer var / clearTimeout left after the setTimeout/setInterval was deleted; `.then((x) => x.data)` or `Promise.resolve(call(...))` where the value is never used/returned; new parameterless function returning only a literal.

## Remove unused imports, declarations, props, and exports  ·  `remove-unused-declarations`
- **Severity:** nit  ·  **Support:** 7  ·  **Seen in:** #1221, #24725, #25937, #26401, #27913, #28442
- **Rule:** Flag a newly added or refactor-orphaned identifier with zero references: unused imports, error classes, single-use type aliases, component props declared but never read, destructured setters never called, and exports no longer imported anywhere. Prioritize unused error classes and exports, which mislead readers about behavior; skip cases an existing eslint no-unused config already blocks.
- **Detect:** For each added/changed `import`, `const`, `type X = ...`, `class`, exported symbol, or component prop, grep the rest of the file (and repo, for exports) for another reference. Zero usages => flag. Also flag tuple destructure `const [v, setV] = createSignal/useState` where the setter is never used afterward.

## Keep names and docs accurate to actual behavior  ·  `names-must-match-behavior`
- **Severity:** nit  ·  **Support:** 7  ·  **Seen in:** #62, #3136, #4873, #27053, #27229, #28308
- **Rule:** Flag when an identifier or doc no longer matches behavior: plural/general names whose body handles one case, memo/variable names left stale after a condition is widened (added OR branch), tool/param docs out of sync with schema keys, and doc edits that flip conditional 'or'/'else' semantics into 'and'/unconditional.
- **Detect:** Compare function/variable names using plural/general nouns or boolean predicates against their bodies and widened conditions. Cross-check parameter names in a tool's description/.txt prompt against the actual schema keys. Cross-check named packages/paths in doc/CI text against packages/* dirs. Flag doc edits that flip 'or'/conditional phrasing to 'and'/unconditional.

## Reconcile every dependent usage when updating a doc's vocabulary, state machine, or claims  ·  `doc-vocabulary-and-state-machine-must-stay-internally-consistent`
- **Severity:** nit  ·  **Support:** 6  ·  **Seen in:** #1, #104, #113, #120, #123
- **Rule:** When a diff updates a canonical definition, enum/variant set, state-machine transitions, or makes a universal behavioral claim in docs/ADRs/prompts, reconcile every dependent usage in the same change: grep the file (and nearby docs) for old terms/removed states and update example sentences, transition lists, and origin/semantics claims, so the document presents one consistent model. Also verify every implementation actually satisfies any 'each/every <verb> does X' guarantee, and that cross-reference links point at the document that genuinely owns the named topic. And collapse redundant duplicated phrasing within a single sentence.
- **Detect:** A doc/ADR diff edits an enumerated set/definition/transition list or asserts 'each/every <thing> does X', but another line still uses the superseded vocabulary, lists a removed state ('edited'), describes a variant's wrong origin, or an implementing fn omits the asserted step; or a link's descriptive text names a topic the target file delegates elsewhere; or a sentence repeats the same phrase twice. Flag the inconsistency.

## Extract repeated magic constants into a single named value  ·  `extract-repeated-magic-constants`
- **Severity:** nit  ·  **Support:** 3  ·  **Seen in:** #1723, #27887, #28780
- **Rule:** When the same magic literal (a duration, limit, or threshold) appears in 2+ distinct statements in one changed file, suggest extracting one named constant so the value stays consistent. Limit to semantically-linked duplicates; ignore incidental repeats of trivial values like 0/1/empty-string.
- **Detect:** Within one changed file, count identical literal durations/limits (e.g. "5 seconds", 600, 5000) appearing 2+ times in different statements. Also flag a literal key added to an object where sibling entries are produced via .map/Object.fromEntries/conditional spreads from config, or whose casing differs from adjacent single-token keys.

## Use type-only imports for typing needs instead of ReturnType<typeof valueFn>  ·  `avoid-type-only-runtime-import-cycles`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #416, #25941
- **Rule:** Flag `ReturnType<typeof X>`/`Parameters<typeof X>` used purely for typing where X is a value imported from a module that also imports the current one; prefer a dedicated exported type usable via `import type` to avoid forcing a runtime import and a circular dependency.
- **Detect:** Flag `ReturnType<typeof X>` / `Parameters<typeof X>` in a type position where `X` is imported from a module that also imports the current module; ask whether a dedicated exported type would let the import be `import type` and avoid a runtime cycle.

## Match log level to event severity  ·  `match-log-level-to-severity`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #26262
- **Rule:** Flag `log.error`/`console.error` used inside handlers for normal success/recovery events (responsive, connected, ready, recovered, resumed); these should be info/debug (or warn to note a prior degraded state), reserving error for actual failures.
- **Detect:** Flag `log.error`/`console.error` calls inside handlers for success/recovery events (handler names like 'responsive', 'connected', 'ready', 'recovered', 'resumed').

## Keep a doc comment attached to its type when inserting a new item between them  ·  `doc-comment-stays-attached-to-its-type-when-inserting-items`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #106, #123
- **Rule:** When inserting a new type/item between an existing doc comment and the type it documents, move the doc comment to stay attached to its intended type. Otherwise the generated docs attach the comment to the wrong (newly-inserted) item and leave the original type undocumented. Likewise update comments referencing an identifier that was renamed in the same diff.
- **Detect:** A diff inserts a new `#[derive] pub struct X` between an existing `/// ...` doc block and a different struct — does the doc block's described type name match the struct directly below it? Or a rename whose nearby comments still use the old identifier. Mismatch = misattached/stale doc.

## Don't add a config flag for behavior that should have one correct value  ·  `no-config-flag-for-should-be-unconditional-behavior`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #302, #777
- **Rule:** Avoid introducing a new settings/options flag to gate behavior that maintainers consider should always apply; prefer a single hard-coded correct behavior unless there is a genuine use case for both modes. Also avoid over-nesting a single flag into a new sub-interface (StartupSettings) when a flat property would do.
- **Detect:** A diff adds a new optional field to an options/settings interface plus branching on it where the non-default value only preserves a worse old behavior; or a new interface XxxSettings holding essentially one flag nested into the main Settings type.

## De-duplicate before appending to a persisted membership/registration list  ·  `dedupe-before-appending-persisted-list`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #27053
- **Rule:** Flag pushing an id onto a persisted/serialized collection of identifiers without an inclusion guard or Set/keyed-map representation; ask what happens on re-run (retry, restarted session) with the same id.
- **Detect:** Look for `array.push(id)` into a persisted/serialized collection with no preceding `.includes()`/`.find()` guard and no Set/keyed-object representation. Ask: what happens if this runs twice with the same id?

## Use typed ORM table/column references instead of hardcoded raw SQL identifiers  ·  `prefer-typed-orm-over-raw-sql-identifiers`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #30705
- **Rule:** In a file that defines/imports typed ORM table objects (Drizzle/Prisma/etc.), flag raw SQL string literals hardcoding table/column names also available via the typed objects; prefer the typed API so schema refactors fail at compile time.
- **Detect:** In files importing/defining ORM table objects, flag raw SQL string literals (sql`...`) that hardcode table/column identifiers also available as typed table objects used elsewhere in the file.

## Don't fabricate struct fields with placeholder defaults — query the real values  ·  `no-synthetic-row-fields-query-real-values`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #131
- **Rule:** Don't fabricate domain-row struct fields with placeholder zeros/defaults (created_at/updated_at = 0) to satisfy a type when the data is available. Query the full row and map it through the shared row-mapping helper so all fields are real; synthetic timestamps silently corrupt any consumer that sorts or renders by them.
- **Detect:** A fn constructs a row/DTO struct manually with literal 0/default for fields like created_at/updated_at while a shared mapper (entity_row(...)) exists. Ask: are any non-trivial fields filled with 0/default instead of real DB values?

## Use a consistent format specifier across sibling error messages for the same value  ·  `consistent-format-specifier-across-sibling-error-messages`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #77
- **Rule:** Use a consistent format specifier across error messages describing the same kind of value (always {:?} to quote identifiers, or always {}). Two adjacent error messages interpolating the same variable with different specifiers ({:?} Debug vs {} Display) produce inconsistent user-facing output (quoted vs unquoted) for messages that should be uniform.
- **Detect:** Two format! calls in the same function interpolate the same variable with different specifiers ({:?} vs {}). Ask: do sibling error messages for the same field render the value with mismatched Debug/Display formatting?

## Assert the separator-free invariant a delimiter-joining helper relies on  ·  `assert-input-invariant-relied-on-by-delimiter-joining`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #106
- **Rule:** When a helper builds a delimiter-joined string (push(' '), join(',')) that the consumer later re-splits on that delimiter, and it relies on the inputs being free of the separator, add a debug_assert!/assert! enforcing that invariant. Today's callers may be safe, but a future arg containing the delimiter would silently produce a malformed result; the assert makes future callers fail loudly.
- **Detect:** Helpers building a delimiter-joined string destined to be re-split by the consumer, where inputs come from callers and there is no assert the inputs lack the delimiter. Suggest a debug_assert guarding the separator.

## Place eslint-disable on the exact line that triggers the rule  ·  `no-misplaced-eslint-disable`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #1694
- **Rule:** Place an eslint-disable suppression on the exact line/parameter that triggers the rule (the any parameter, not an adjacent string parameter); a misplaced disable suppresses nothing and is misleading. Verify the annotated line actually violates the named rule, or replace any with unknown and narrow.
- **Detect:** eslint-disable-line / eslint-disable-next-line @typescript-eslint/no-explicit-any where the targeted line/parameter does not actually contain : any.

## Don't reassign a variable from a function that mutates its argument in place  ·  `no-misleading-mutating-reassignment`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #584
- **Rule:** Do not write `x = fn(x)` when fn's real effect is in-place mutation of its argument (maybeAddOpenRouterAnthropicCacheControl mutates messages); the reassignment falsely implies fn is pure. Either make fn pure and return a new value, or call it for its side effect without the misleading reassignment.
- **Detect:** let x = build(); x = fn(x); where fn's name/impl indicates it mutates the argument in place.
